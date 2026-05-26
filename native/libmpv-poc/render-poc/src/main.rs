//! R1 offscreen render-to-PNG proof-of-concept (Approach B, Stage B-Render).
//!
//! Proves the libmpv **render API** can produce a real video frame with NO
//! window and NO Electron:
//!   1. load `libmpv-2.dll` at runtime (libloading),
//!   2. create an OFFSCREEN GLES context via ANGLE/EGL (pbuffer, no window),
//!   3. create an `mpv_render_context` (OpenGL/GLES),
//!   4. open a direct HTTP/HTTPS URL,
//!   5. render one frame into an FBO, read it back, save `frame.png`,
//!   6. clean up and exit.
//!
//! Isolated: does not touch the headless addon, `src/**`, `electron/**`, the
//! root `package.json`, or the app. Run with `cargo run --release -- <url>`.
//!
//! NOTE: this is the most uncertain stage and is authored without a Windows
//! compiler to hand. The EGL/GL plumbing and the render-API struct layout are
//! written to the documented C ABI; if `cargo` reports an error, paste it and
//! we'll adjust precisely.

use std::ffi::{c_void, CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::time::{Duration, Instant};

use khronos_egl as egl;
use libloading::{Library, Symbol};

type Egl = egl::DynamicInstance<egl::EGL1_4>;

// ---- Render target size (the FBO mpv renders into; source is scaled to fit) --
const W: i32 = 1280;
const H: i32 = 720;

// ---- libmpv C ABI constants ------------------------------------------------
const MPV_RENDER_PARAM_INVALID: c_int = 0;
const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;

const MPV_EVENT_NONE: c_int = 0;
const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_FILE_LOADED: c_int = 8;

#[repr(C)]
struct MpvRenderParam {
    type_: c_int,
    data: *mut c_void,
}

type GetProcAddress = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;

#[repr(C)]
struct MpvOpenglInitParams {
    get_proc_address: GetProcAddress,
    get_proc_address_ctx: *mut c_void,
}

#[repr(C)]
struct MpvOpenglFbo {
    fbo: c_int,
    w: c_int,
    h: c_int,
    internal_format: c_int,
}

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

// ---- libmpv function-pointer types ----------------------------------------
type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> c_int;
type MpvSetOptionString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int;
type MpvGetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent;
type MpvFree = unsafe extern "C" fn(*mut c_void);
type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
type MpvRenderContextCreate =
    unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *const MpvRenderParam) -> c_int;
type MpvRenderContextRender = unsafe extern "C" fn(*mut c_void, *const MpvRenderParam) -> c_int;
type MpvRenderContextFree = unsafe extern "C" fn(*mut c_void);

// ---- OpenGL ES function-pointer types (resolved via eglGetProcAddress) -----
// GL on Windows uses the "system" calling convention (GL_APIENTRY = stdcall on
// win32; same as C on x64).
type GlGenTextures = unsafe extern "system" fn(c_int, *mut u32);
type GlBindTexture = unsafe extern "system" fn(u32, u32);
type GlTexImage2D =
    unsafe extern "system" fn(u32, c_int, c_int, c_int, c_int, c_int, u32, u32, *const c_void);
type GlTexParameteri = unsafe extern "system" fn(u32, u32, c_int);
type GlGenFramebuffers = unsafe extern "system" fn(c_int, *mut u32);
type GlBindFramebuffer = unsafe extern "system" fn(u32, u32);
type GlFramebufferTexture2D = unsafe extern "system" fn(u32, u32, u32, u32, c_int);
type GlCheckFramebufferStatus = unsafe extern "system" fn(u32) -> u32;
type GlViewport = unsafe extern "system" fn(c_int, c_int, c_int, c_int);
type GlReadPixels = unsafe extern "system" fn(c_int, c_int, c_int, c_int, u32, u32, *mut c_void);
type GlFinish = unsafe extern "system" fn();
type GlGetError = unsafe extern "system" fn() -> u32;

// GL enum constants we need.
const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_RGBA: u32 = 0x1908;
const GL_RGBA8: u32 = 0x8058;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_LINEAR: c_int = 0x2601;

/// All resolved GL entry points.
struct Gl {
    gen_textures: GlGenTextures,
    bind_texture: GlBindTexture,
    tex_image_2d: GlTexImage2D,
    tex_parameteri: GlTexParameteri,
    gen_framebuffers: GlGenFramebuffers,
    bind_framebuffer: GlBindFramebuffer,
    framebuffer_texture_2d: GlFramebufferTexture2D,
    check_framebuffer_status: GlCheckFramebufferStatus,
    viewport: GlViewport,
    read_pixels: GlReadPixels,
    finish: GlFinish,
    get_error: GlGetError,
}

unsafe fn load_gl<T>(egl: &Egl, name: &str) -> T {
    let f = egl
        .get_proc_address(name)
        .unwrap_or_else(|| panic!("GL function not found via eglGetProcAddress: {name}"));
    std::mem::transmute_copy::<extern "system" fn(), T>(&f)
}

/// get_proc_address callback handed to libmpv; resolves GL via our EGL instance.
unsafe extern "C" fn mpv_get_proc_address(ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    if ctx.is_null() || name.is_null() {
        return std::ptr::null_mut();
    }
    let egl = &*(ctx as *const Egl);
    let cname = match CStr::from_ptr(name).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    match egl.get_proc_address(cname) {
        Some(f) => f as *mut c_void,
        None => std::ptr::null_mut(),
    }
}

unsafe fn sym<T>(lib: &Library, name: &[u8]) -> T {
    let s: Symbol<T> = lib
        .get(name)
        .unwrap_or_else(|e| panic!("missing libmpv symbol {}: {e}", String::from_utf8_lossy(name)));
    std::mem::transmute_copy::<Symbol<T>, T>(&s)
}

fn main() {
    // Resolve vendor DLL locations relative to this crate (../vendor/...).
    let manifest = env!("CARGO_MANIFEST_DIR"); // .../native/libmpv-poc/render-poc
    let base = Path::new(manifest)
        .parent()
        .expect("crate has a parent dir"); // .../native/libmpv-poc
    let angle_dir = base.join("vendor").join("angle");
    let libmpv_dir = base.join("vendor").join("libmpv");
    let libmpv_dll = libmpv_dir.join("libmpv-2.dll");

    // Prepend the vendor folders to PATH so libEGL.dll / libGLESv2.dll (ANGLE)
    // and libmpv-2.dll resolve at load time.
    let old_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!(
        "{};{};{}",
        angle_dir.display(),
        libmpv_dir.display(),
        old_path
    );
    std::env::set_var("PATH", new_path);

    let url = std::env::args().nth(1).unwrap_or_else(|| {
        "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4"
            .to_string()
    });

    println!("[render-poc] libmpv : {}", libmpv_dll.display());
    println!("[render-poc] angle  : {}", angle_dir.display());
    println!("[render-poc] url    : {url}");

    if !libmpv_dll.exists() {
        eprintln!(
            "[render-poc] ERROR: libmpv-2.dll not found at {}",
            libmpv_dll.display()
        );
        std::process::exit(1);
    }

    unsafe {
        run(&libmpv_dll.to_string_lossy(), &url);
    }
}

unsafe fn run(libmpv_path: &str, url: &str) {
    // ---- 1. Load libmpv + resolve symbols --------------------------------
    let mpvlib = Library::new(libmpv_path)
        .unwrap_or_else(|e| panic!("failed to load libmpv-2.dll: {e}"));
    let mpv_create: MpvCreate = sym(&mpvlib, b"mpv_create\0");
    let mpv_initialize: MpvInitialize = sym(&mpvlib, b"mpv_initialize\0");
    let mpv_set_option_string: MpvSetOptionString = sym(&mpvlib, b"mpv_set_option_string\0");
    let mpv_command: MpvCommand = sym(&mpvlib, b"mpv_command\0");
    let mpv_get_property_string: MpvGetPropertyString =
        sym(&mpvlib, b"mpv_get_property_string\0");
    let mpv_wait_event: MpvWaitEvent = sym(&mpvlib, b"mpv_wait_event\0");
    let mpv_free: MpvFree = sym(&mpvlib, b"mpv_free\0");
    let mpv_terminate_destroy: MpvTerminateDestroy = sym(&mpvlib, b"mpv_terminate_destroy\0");
    let mpv_render_context_create: MpvRenderContextCreate =
        sym(&mpvlib, b"mpv_render_context_create\0");
    let mpv_render_context_render: MpvRenderContextRender =
        sym(&mpvlib, b"mpv_render_context_render\0");
    let mpv_render_context_free: MpvRenderContextFree =
        sym(&mpvlib, b"mpv_render_context_free\0");

    // ---- 2. Offscreen EGL/ANGLE context (pbuffer, no window) -------------
    let egl = egl::DynamicInstance::<egl::EGL1_4>::load_required_from_filename("libEGL.dll")
        .expect("failed to load libEGL.dll (ANGLE) — is it in vendor/angle/ ?");

    let display = egl
        .get_display(egl::DEFAULT_DISPLAY)
        .expect("eglGetDisplay returned no display");
    let (major, minor) = egl.initialize(display).expect("eglInitialize failed");
    println!("[render-poc] EGL initialized: {major}.{minor}");

    let config_attribs = [
        egl::SURFACE_TYPE,
        egl::PBUFFER_BIT,
        egl::RENDERABLE_TYPE,
        egl::OPENGL_ES2_BIT,
        egl::RED_SIZE,
        8,
        egl::GREEN_SIZE,
        8,
        egl::BLUE_SIZE,
        8,
        egl::ALPHA_SIZE,
        8,
        egl::NONE,
    ];
    let config = egl
        .choose_first_config(display, &config_attribs)
        .expect("eglChooseConfig failed")
        .expect("no matching EGL config");

    let pbuffer_attribs = [egl::WIDTH, W, egl::HEIGHT, H, egl::NONE];
    let surface = egl
        .create_pbuffer_surface(display, config, &pbuffer_attribs)
        .expect("eglCreatePbufferSurface failed");

    egl.bind_api(egl::OPENGL_ES_API).expect("eglBindAPI failed");

    // Request GLES3; fall back to GLES2 if needed.
    let context = {
        let attribs3 = [egl::CONTEXT_CLIENT_VERSION, 3, egl::NONE];
        match egl.create_context(display, config, None, &attribs3) {
            Ok(c) => c,
            Err(_) => {
                let attribs2 = [egl::CONTEXT_CLIENT_VERSION, 2, egl::NONE];
                egl.create_context(display, config, None, &attribs2)
                    .expect("eglCreateContext failed (GLES3 and GLES2)")
            }
        }
    };
    egl.make_current(display, Some(surface), Some(surface), Some(context))
        .expect("eglMakeCurrent failed");
    println!("[render-poc] EGL pbuffer + GLES context current");

    // ---- 3. Resolve the GL entry points we use ---------------------------
    let gl = Gl {
        gen_textures: load_gl(&egl, "glGenTextures"),
        bind_texture: load_gl(&egl, "glBindTexture"),
        tex_image_2d: load_gl(&egl, "glTexImage2D"),
        tex_parameteri: load_gl(&egl, "glTexParameteri"),
        gen_framebuffers: load_gl(&egl, "glGenFramebuffers"),
        bind_framebuffer: load_gl(&egl, "glBindFramebuffer"),
        framebuffer_texture_2d: load_gl(&egl, "glFramebufferTexture2D"),
        check_framebuffer_status: load_gl(&egl, "glCheckFramebufferStatus"),
        viewport: load_gl(&egl, "glViewport"),
        read_pixels: load_gl(&egl, "glReadPixels"),
        finish: load_gl(&egl, "glFinish"),
        get_error: load_gl(&egl, "glGetError"),
    };

    // Build an RGBA8 texture + FBO of WxH.
    let mut tex: u32 = 0;
    (gl.gen_textures)(1, &mut tex);
    (gl.bind_texture)(GL_TEXTURE_2D, tex);
    (gl.tex_image_2d)(
        GL_TEXTURE_2D,
        0,
        GL_RGBA8 as c_int,
        W,
        H,
        0,
        GL_RGBA,
        GL_UNSIGNED_BYTE,
        std::ptr::null(),
    );
    (gl.tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    (gl.tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

    let mut fbo: u32 = 0;
    (gl.gen_framebuffers)(1, &mut fbo);
    (gl.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
    (gl.framebuffer_texture_2d)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    let status = (gl.check_framebuffer_status)(GL_FRAMEBUFFER);
    if status != GL_FRAMEBUFFER_COMPLETE {
        panic!("FBO incomplete: 0x{status:X}");
    }
    (gl.viewport)(0, 0, W, H);
    println!("[render-poc] FBO {W}x{H} ready (texture {tex}, fbo {fbo})");

    // ---- 4. Create the mpv handle + render context -----------------------
    let mpv = mpv_create();
    if mpv.is_null() {
        panic!("mpv_create returned null");
    }
    let set_opt = |name: &str, val: &str| {
        if let (Ok(n), Ok(v)) = (CString::new(name), CString::new(val)) {
            mpv_set_option_string(mpv, n.as_ptr(), v.as_ptr());
        }
    };
    set_opt("vo", "libmpv"); // required for the render API
    set_opt("ao", "null"); // no audio device needed for the PoC
    set_opt("hwdec", "no"); // software decode keeps the GL path simple
    set_opt("network-timeout", "15");
    let rc = mpv_initialize(mpv);
    if rc < 0 {
        panic!("mpv_initialize failed (code {rc})");
    }

    if let Some(v) = get_prop_string(mpv_get_property_string, mpv_free, mpv, "mpv-version") {
        println!("[render-poc] libmpv loaded: {v}");
    }

    let api = CString::new("opengl").unwrap();
    let mut gl_init = MpvOpenglInitParams {
        get_proc_address: mpv_get_proc_address,
        get_proc_address_ctx: &egl as *const Egl as *mut c_void,
    };
    let create_params = [
        MpvRenderParam {
            type_: MPV_RENDER_PARAM_API_TYPE,
            data: api.as_ptr() as *mut c_void,
        },
        MpvRenderParam {
            type_: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
            data: &mut gl_init as *mut _ as *mut c_void,
        },
        MpvRenderParam {
            type_: MPV_RENDER_PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ];
    let mut rctx: *mut c_void = std::ptr::null_mut();
    let rc = mpv_render_context_create(&mut rctx, mpv, create_params.as_ptr());
    if rc < 0 || rctx.is_null() {
        panic!("mpv_render_context_create failed (code {rc})");
    }
    println!("[render-poc] mpv_render_context created");

    // ---- 5. Load the URL, render until a non-blank frame appears ---------
    let c_load = CString::new("loadfile").unwrap();
    let c_url = CString::new(url).unwrap();
    let argv: [*const c_char; 3] = [c_load.as_ptr(), c_url.as_ptr(), std::ptr::null()];
    if mpv_command(mpv, argv.as_ptr()) < 0 {
        panic!("loadfile command failed");
    }

    // Wait for file-loaded (drains events so mpv progresses).
    let mut file_loaded = false;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !file_loaded {
        let evp = mpv_wait_event(mpv, 0.25);
        if !evp.is_null() {
            match (*evp).event_id {
                MPV_EVENT_FILE_LOADED => {
                    file_loaded = true;
                    println!("[render-poc] file-loaded");
                }
                MPV_EVENT_SHUTDOWN => break,
                MPV_EVENT_NONE => {}
                _ => {}
            }
        }
    }
    if !file_loaded {
        eprintln!("[render-poc] WARNING: no file-loaded event; trying to render anyway");
    }

    let mut rgba = vec![0u8; (W * H * 4) as usize];
    let mut non_black_pct = 0.0f64;
    let mut got_frame = false;
    let fbo_struct = MpvOpenglFbo {
        fbo: fbo as c_int,
        w: W,
        h: H,
        internal_format: 0,
    };

    for attempt in 0..40 {
        // Drain any pending events so decoding keeps progressing.
        loop {
            let evp = mpv_wait_event(mpv, 0.0);
            if evp.is_null() || (*evp).event_id == MPV_EVENT_NONE {
                break;
            }
        }

        let mut fbo_param = MpvOpenglFbo { ..fbo_struct };
        let mut flip: c_int = 1;
        let render_params = [
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_OPENGL_FBO,
                data: &mut fbo_param as *mut _ as *mut c_void,
            },
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_FLIP_Y,
                data: &mut flip as *mut _ as *mut c_void,
            },
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        mpv_render_context_render(rctx, render_params.as_ptr());
        (gl.finish)();

        // Read the FBO back.
        (gl.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
        (gl.read_pixels)(
            0,
            0,
            W,
            H,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            rgba.as_mut_ptr() as *mut c_void,
        );
        let glerr = (gl.get_error)();
        if glerr != 0 {
            eprintln!("[render-poc] glGetError after readback: 0x{glerr:X}");
        }

        non_black_pct = non_black_percent(&rgba);
        if non_black_pct > 1.0 {
            got_frame = true;
            println!(
                "[render-poc] frame on attempt {attempt}: {:.1}% non-black",
                non_black_pct
            );
            break;
        }
        std::thread::sleep(Duration::from_millis(120));
    }

    // ---- 6. Save PNG + clean up ------------------------------------------
    // GL reads bottom-up; flip rows so the PNG is upright.
    let mut flipped = vec![0u8; rgba.len()];
    let row = (W * 4) as usize;
    for y in 0..H as usize {
        let src = y * row;
        let dst = (H as usize - 1 - y) * row;
        flipped[dst..dst + row].copy_from_slice(&rgba[src..src + row]);
    }
    write_png("frame.png", &flipped, W as u32, H as u32);
    println!("[render-poc] wrote frame.png");

    mpv_render_context_free(rctx);
    mpv_terminate_destroy(mpv);
    let _ = egl.make_current(display, None, None, None);
    let _ = egl.destroy_context(display, context);
    let _ = egl.destroy_surface(display, surface);
    let _ = egl.terminate(display);

    if got_frame {
        println!("[render-poc] SUCCESS ✅  rendered a real frame to frame.png ({non_black_pct:.1}% non-black)");
        std::process::exit(0);
    } else {
        eprintln!("[render-poc] INCOMPLETE ⚠️  frame.png is blank/near-black ({non_black_pct:.1}% non-black). See errors above.");
        std::process::exit(2);
    }
}

unsafe fn get_prop_string(
    f: MpvGetPropertyString,
    free: MpvFree,
    mpv: *mut c_void,
    name: &str,
) -> Option<String> {
    let cname = CString::new(name).ok()?;
    let p = f(mpv, cname.as_ptr());
    if p.is_null() {
        return None;
    }
    let s = CStr::from_ptr(p).to_string_lossy().into_owned();
    free(p as *mut c_void);
    Some(s)
}

/// Percentage of pixels whose R, G, or B is above a small threshold.
fn non_black_percent(rgba: &[u8]) -> f64 {
    let mut non_black = 0usize;
    let total = rgba.len() / 4;
    for px in rgba.chunks_exact(4) {
        if px[0] > 16 || px[1] > 16 || px[2] > 16 {
            non_black += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        (non_black as f64) * 100.0 / (total as f64)
    }
}

fn write_png(path: &str, rgba: &[u8], w: u32, h: u32) {
    use std::fs::File;
    use std::io::BufWriter;
    let file = File::create(path).expect("create frame.png");
    let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("png header");
    writer.write_image_data(rgba).expect("png data");
}
