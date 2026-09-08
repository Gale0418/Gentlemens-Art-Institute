use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFolderResponse {
    pub bookmark: String,
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAccessingRequest {
    pub bookmark: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAccessingResponse {
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopAccessingRequest {
    pub bookmark: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureAvailableRequest {
    pub bookmark: String,
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureAvailableResponse {
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoLibraryStatusRequest {
    #[serde(default)]
    pub request_authorization: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PhotoLibraryAlbum {
    pub id: String,
    pub title: String,
    pub count: usize,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoLibraryStatusResponse {
    pub authorization: String,
    #[serde(default)]
    pub albums: Vec<PhotoLibraryAlbum>,
    #[serde(default)]
    pub linked_album_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetLinkedPhotoAlbumsRequest {
    pub album_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetLinkedPhotoAlbumsResponse {
    pub authorization: String,
    #[serde(default)]
    pub linked_album_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPhotoAlbumSnapshotsResponse {
    pub authorization: String,
    #[serde(default)]
    pub albums: Vec<LinkedPhotoAlbumSnapshot>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPhotoAlbumSnapshot {
    pub id: String,
    pub title: String,
    pub available: bool,
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PhotoAssetImageRequest {
    pub album_id: String,
    pub asset_id: String,
    pub thumbnail: bool,
    pub allow_network: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PhotoAssetImageResponse {
    pub path: String,
    pub mime_type: String,
}
