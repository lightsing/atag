//! Shared validation for Apple's machine provisioning directory and plist replies.
use super::local;
use crate::error::ApiError;
use plist::Value;
use reqwest::Url;

pub(super) const LOOKUP: &str = "https://gsa.apple.com/grandslam/GsService2/lookup";

pub(super) fn apple_url(url: &str) -> Result<Url, ApiError> {
    let url = Url::parse(url).map_err(|_| local::failure("Apple 机器注册地址无效。"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("gsa.apple.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(local::failure("Apple 机器注册地址不受支持。"));
    }
    Ok(url)
}

pub(super) fn plist_field<'a>(value: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    value
        .as_dictionary()
        .and_then(|d| d.get(name))
        .and_then(Value::as_string)
        .ok_or_else(|| local::failure("Apple 机器注册响应缺少必要字段。"))
}
