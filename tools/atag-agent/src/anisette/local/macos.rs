//! Dynamically load system frameworks; no private framework link at build time.
use super::Headers;
use objc2::{
    msg_send,
    rc::{Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
    sel,
};
use objc2_foundation::{NSBundle, NSString};

unsafe fn string(
    receiver: &AnyObject,
    selector: objc2::runtime::Sel,
) -> Result<String, &'static str> {
    let supported: bool = unsafe { msg_send![receiver, respondsToSelector:selector] };
    if !supported {
        return Err("device selector unavailable");
    }
    let value: Option<Retained<NSString>> =
        unsafe { msg_send![receiver, performSelector:selector] };
    value
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or("device metadata unavailable")
}
pub(super) fn headers() -> Result<Headers, &'static str> {
    autoreleasepool(|_| unsafe {
        for path in [
            "/System/Library/PrivateFrameworks/AOSKit.framework",
            "/System/Library/PrivateFrameworks/AuthKit.framework",
        ] {
            let bundle = NSBundle::bundleWithPath(&NSString::from_str(path))
                .ok_or("framework bundle missing")?;
            if !bundle.load() {
                return Err("framework load failed");
            }
        }
        let aos = AnyClass::get(c"AOSUtilities").ok_or("AOSUtilities unavailable")?;
        let ak = AnyClass::get(c"AKDevice").ok_or("AKDevice unavailable")?;
        let supported: bool = msg_send![aos,respondsToSelector:sel!(retrieveOTPHeadersForDSID:)];
        if !supported {
            return Err("OTP selector unavailable");
        }
        let otp: Option<Retained<AnyObject>> =
            msg_send![aos,retrieveOTPHeadersForDSID:&*NSString::from_str("-2")];
        let otp = otp.ok_or("OTP service returned no data")?;
        let device: Option<Retained<AnyObject>> = msg_send![ak, currentDevice];
        let device = device.ok_or("current device unavailable")?;
        let mut result = Headers::new();
        for (source, target) in [
            ("X-Apple-MD", "X-Apple-I-MD"),
            ("X-Apple-MD-M", "X-Apple-I-MD-M"),
        ] {
            let mut value: Option<Retained<NSString>> =
                msg_send![&*otp,objectForKey:&*NSString::from_str(source)];
            if value.is_none() {
                value = msg_send![&*otp,objectForKey:&*NSString::from_str(target)];
            }
            result.insert(
                target.into(),
                value.ok_or("OTP dictionary incomplete")?.to_string(),
            );
        }
        for (key, selector) in [
            ("X-Apple-I-MD-LU", sel!(localUserUUID)),
            ("X-Mme-Device-Id", sel!(uniqueDeviceIdentifier)),
            ("X-Mme-Client-Info", sel!(serverFriendlyDescription)),
        ] {
            result.insert(key.into(), string(&device, selector)?);
        }
        let serial: Option<Retained<NSString>> = msg_send![aos, machineSerialNumber];
        result.insert(
            "X-Apple-I-SRL-NO".into(),
            serial.ok_or("serial unavailable")?.to_string(),
        );
        result.insert("X-Apple-I-MD-RINFO".into(), "17106176".into());
        Ok(result)
    })
}
