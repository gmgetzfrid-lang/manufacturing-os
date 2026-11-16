//! The API key at rest: encrypted with Windows DPAPI for the signed-in user
//! (only this Windows account on this PC can read it back).

use base64::Engine;

#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};
    let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if protect {
            CryptProtectData(&mut input, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&mut input, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let v = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Some(v)
}

#[cfg(not(windows))]
fn dpapi(data: &[u8], _protect: bool) -> Option<Vec<u8>> {
    // Development builds only: no OS key store; kept as-is.
    Some(data.to_vec())
}

pub fn seal(key: &str) -> Option<String> {
    dpapi(key.as_bytes(), true).map(|v| base64::engine::general_purpose::STANDARD.encode(v))
}

pub fn open(sealed: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(sealed).ok()?;
    dpapi(&raw, false).and_then(|v| String::from_utf8(v).ok())
}
