//! Headless libmpv proof-of-concept (Approach B, B-Headless stage).
//!
//! Proves the native path works WITHOUT any rendering:
//!   1. the addon builds,
//!   2. `libmpv-2.dll` loads **at runtime** (no import lib / headers needed),
//!   3. the mpv version can be read,
//!   4. a direct HTTP/HTTPS URL loads,
//!   5. time-pos / duration / pause and file-loaded / end-file events are read,
//!   6. cleanup runs without crashing.
//!
//! Linking: we deliberately do NOT link libmpv at build time. The Windows dev
//! packages ship only `libmpv.dll.a` (MinGW), not an MSVC `mpv.lib`, so we open
//! `libmpv-2.dll` with `libloading` and call its C ABI directly. Only the
//! handful of symbols below are resolved. No video/audio output (`vo=null`,
//! `ao=null`); playback still advances in real time so properties/events work.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::time::{Duration, Instant};

use libloading::{Library, Symbol};

// ---- libmpv C ABI constants (from mpv/client.h) --------------------------
const MPV_FORMAT_FLAG: c_int = 3;
const MPV_FORMAT_DOUBLE: c_int = 5;

const MPV_EVENT_NONE: c_int = 0;
const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_FILE_LOADED: c_int = 8;

/// Mirror of `mpv_event`. We only read `event_id`; the rest is layout padding so
/// the pointer we get from mpv_wait_event is interpreted correctly.
#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

// ---- Function-pointer types for the symbols we use -----------------------
type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> c_int;
type MpvSetOptionString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int;
type MpvGetProperty = unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut c_void) -> c_int;
type MpvGetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent;
type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
type MpvFree = unsafe extern "C" fn(*mut c_void);

/// Result of the headless run, returned to JS (fields are camelCased in JS).
#[napi(object)]
pub struct DemoReport {
    pub mpv_version: String,
    pub created: bool,
    pub file_loaded: bool,
    pub eof_reached: bool,
    pub duration: Option<f64>,
    pub last_time_pos: Option<f64>,
    pub paused: Option<bool>,
    /// Count of successful time-pos reads (proves the poll loop advances).
    pub property_reads: u32,
    pub events_log: Vec<String>,
}

fn err(msg: String) -> napi::Error {
    napi::Error::from_reason(msg)
}

/// Resolve a symbol and copy out its function pointer (valid while `lib` lives).
unsafe fn getsym<T: Copy>(lib: &Library, name: &[u8]) -> Result<T> {
    let s: Symbol<T> = lib.get(name).map_err(|e| {
        err(format!(
            "symbol {} not found in libmpv: {e}",
            String::from_utf8_lossy(&name[..name.len().saturating_sub(1)])
        ))
    })?;
    Ok(*s)
}

/// Owns the loaded library + an initialized mpv handle + the runtime fns.
/// Dropping it terminates mpv cleanly (before the library is unloaded).
struct MpvLib {
    _lib: Library,
    ctx: *mut c_void,
    set_option_string: MpvSetOptionString,
    command: MpvCommand,
    get_property: MpvGetProperty,
    get_property_string: MpvGetPropertyString,
    wait_event: MpvWaitEvent,
    terminate_destroy: MpvTerminateDestroy,
    free: MpvFree,
}

impl MpvLib {
    /// Load libmpv-2.dll from `dll_path`, create + initialize a handle, and set
    /// headless options (vo/ao = null) BEFORE initialize.
    unsafe fn load(dll_path: &str) -> Result<Self> {
        let lib = Library::new(dll_path)
            .map_err(|e| err(format!("failed to load '{dll_path}': {e}")))?;

        let create: MpvCreate = getsym(&lib, b"mpv_create\0")?;
        let initialize: MpvInitialize = getsym(&lib, b"mpv_initialize\0")?;
        let set_option_string: MpvSetOptionString = getsym(&lib, b"mpv_set_option_string\0")?;
        let command: MpvCommand = getsym(&lib, b"mpv_command\0")?;
        let get_property: MpvGetProperty = getsym(&lib, b"mpv_get_property\0")?;
        let get_property_string: MpvGetPropertyString =
            getsym(&lib, b"mpv_get_property_string\0")?;
        let wait_event: MpvWaitEvent = getsym(&lib, b"mpv_wait_event\0")?;
        let terminate_destroy: MpvTerminateDestroy = getsym(&lib, b"mpv_terminate_destroy\0")?;
        let free: MpvFree = getsym(&lib, b"mpv_free\0")?;

        let ctx = create();
        if ctx.is_null() {
            return Err(err("mpv_create returned null".to_string()));
        }

        // Headless options must be set BEFORE mpv_initialize.
        let set_opt = |name: &str, val: &str| {
            if let (Ok(n), Ok(v)) = (CString::new(name), CString::new(val)) {
                set_option_string(ctx, n.as_ptr(), v.as_ptr());
            }
        };
        set_opt("vo", "null");
        set_opt("ao", "null");
        set_opt("network-timeout", "15");

        let rc = initialize(ctx);
        if rc < 0 {
            terminate_destroy(ctx);
            return Err(err(format!("mpv_initialize failed (code {rc})")));
        }

        Ok(MpvLib {
            _lib: lib,
            ctx,
            set_option_string,
            command,
            get_property,
            get_property_string,
            wait_event,
            terminate_destroy,
            free,
        })
    }

    unsafe fn get_prop_string(&self, name: &str) -> Option<String> {
        let cname = CString::new(name).ok()?;
        let p = (self.get_property_string)(self.ctx, cname.as_ptr());
        if p.is_null() {
            return None;
        }
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        (self.free)(p as *mut c_void);
        Some(s)
    }

    unsafe fn get_prop_f64(&self, name: &str) -> Option<f64> {
        let cname = CString::new(name).ok()?;
        let mut val: f64 = 0.0;
        let rc = (self.get_property)(
            self.ctx,
            cname.as_ptr(),
            MPV_FORMAT_DOUBLE,
            &mut val as *mut f64 as *mut c_void,
        );
        if rc == 0 {
            Some(val)
        } else {
            None
        }
    }

    unsafe fn get_prop_flag(&self, name: &str) -> Option<bool> {
        let cname = CString::new(name).ok()?;
        let mut flag: c_int = 0;
        let rc = (self.get_property)(
            self.ctx,
            cname.as_ptr(),
            MPV_FORMAT_FLAG,
            &mut flag as *mut c_int as *mut c_void,
        );
        if rc == 0 {
            Some(flag != 0)
        } else {
            None
        }
    }

    unsafe fn loadfile(&self, url: &str) -> Result<()> {
        let c_load = CString::new("loadfile").unwrap();
        let c_url = CString::new(url).map_err(|_| err("url contains a NUL byte".to_string()))?;
        // NULL-terminated argv: ["loadfile", url, NULL].
        let argv: [*const c_char; 3] = [c_load.as_ptr(), c_url.as_ptr(), std::ptr::null()];
        let rc = (self.command)(self.ctx, argv.as_ptr());
        if rc < 0 {
            return Err(err(format!("loadfile command failed (code {rc})")));
        }
        Ok(())
    }
}

impl Drop for MpvLib {
    fn drop(&mut self) {
        if !self.ctx.is_null() {
            unsafe { (self.terminate_destroy)(self.ctx) };
            self.ctx = std::ptr::null_mut();
        }
        // `_lib` (FreeLibrary) drops after this, i.e. AFTER mpv is terminated.
    }
}

/// Smoke test: load libmpv from `dll_path`, init a handle, return mpv version.
#[napi]
pub fn mpv_version(dll_path: String) -> Result<String> {
    unsafe {
        let m = MpvLib::load(&dll_path)?;
        Ok(m
            .get_prop_string("mpv-version")
            .unwrap_or_else(|| "unknown".to_string()))
    }
}

/// Load a direct HTTP/HTTPS URL headlessly, poll properties + read events for
/// `seconds`, then clean up. Never renders video.
#[napi]
pub fn run_headless_demo(dll_path: String, url: String, seconds: f64) -> Result<DemoReport> {
    let mut report = DemoReport {
        mpv_version: String::new(),
        created: false,
        file_loaded: false,
        eof_reached: false,
        duration: None,
        last_time_pos: None,
        paused: None,
        property_reads: 0,
        events_log: Vec::new(),
    };

    unsafe {
        let m = MpvLib::load(&dll_path)?;
        report.created = true;
        report.mpv_version = m
            .get_prop_string("mpv-version")
            .unwrap_or_else(|| "unknown".to_string());

        m.loadfile(&url)?;

        let deadline = Instant::now() + Duration::from_secs_f64(seconds.max(0.5));
        while Instant::now() < deadline {
            // Read core events (file-loaded / end-file / shutdown). Times out
            // after 0.5s returning MPV_EVENT_NONE. The event is owned by mpv —
            // we must NOT free it.
            let evp = (m.wait_event)(m.ctx, 0.5);
            if !evp.is_null() {
                let id = (*evp).event_id;
                match id {
                    MPV_EVENT_FILE_LOADED => {
                        report.file_loaded = true;
                        report.events_log.push("file-loaded".to_string());
                    }
                    MPV_EVENT_END_FILE => {
                        report.eof_reached = true;
                        report.events_log.push("end-file".to_string());
                    }
                    MPV_EVENT_SHUTDOWN => {
                        report.events_log.push("shutdown".to_string());
                        break;
                    }
                    MPV_EVENT_NONE => {}
                    other => report.events_log.push(format!("event-id {other}")),
                }
            }

            // Poll the properties of interest (best-effort; error => skip).
            if let Some(d) = m.get_prop_f64("duration") {
                report.duration = Some(d);
            }
            if let Some(t) = m.get_prop_f64("time-pos") {
                report.last_time_pos = Some(t);
                report.property_reads += 1;
            }
            if let Some(p) = m.get_prop_flag("pause") {
                report.paused = Some(p);
            }

            if report.eof_reached {
                break;
            }
        }

        // `m` dropped here → mpv_terminate_destroy → library unloaded.
    }

    Ok(report)
}
