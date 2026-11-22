use std::{ffi::c_void, slice};

use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{StoreKitRequest, PRO_PRODUCT_ID};

type Reply = oneshot::Sender<Option<Value>>;

extern "C" {
    fn gai_macos_storekit_available() -> i32;
    fn gai_macos_storekit_request(
        action: i32,
        context: *mut c_void,
        completion: unsafe extern "C" fn(*mut c_void, *const u8, usize),
    );
}

unsafe extern "C" fn complete(context: *mut c_void, bytes: *const u8, length: usize) {
    // Swift returns this context exactly once and lends the bytes for this call only.
    let reply = unsafe { Box::from_raw(context.cast::<Reply>()) };
    let value = if bytes.is_null() {
        None
    } else {
        serde_json::from_slice(unsafe { slice::from_raw_parts(bytes, length) }).ok()
    };
    let _ = reply.send(value);
}

pub(super) async fn request(action: StoreKitRequest) -> Option<Value> {
    // Check availability without calling into Swift on systems that lack its runtime.
    if unsafe { gai_macos_storekit_available() } == 0 {
        return Some(match action {
            StoreKitRequest::CheckPro => json!({ "pro": false }),
            _ => json!({
                "supported": false,
                "pro": false,
                "productId": PRO_PRODUCT_ID,
                "displayPrice": null,
                "status": "unavailable",
                "message": "購買功能需要 macOS 12 或更新版本"
            }),
        });
    }
    let (send, receive) = oneshot::channel();
    let context = Box::into_raw(Box::new(send));
    // The callback owns the sender even if the caller cancels this future.
    unsafe { gai_macos_storekit_request(action as i32, context.cast(), complete) };
    receive.await.ok().flatten()
}
