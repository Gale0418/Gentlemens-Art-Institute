//
//  PhotoLibraryPlugin.swift
//  tauri-plugin-ios-folder
//
//  Read-only PhotoKit bridge for linking user-selected albums to G.A.I.
//

import Foundation
import Photos
import UIKit
import CryptoKit
import Tauri

private enum PhotoLibraryBridgeError: Error {
  case invalidArguments
  case authorizationRequired
  case authorizationUnavailable
  case albumNotLinked
  case albumNotAccessible
  case assetNotFound
  case assetNotInAlbum
  case imageUnavailable
  case imageInCloud
  case imageTimedOut
  case imageCancelled
  case imageEncodingFailed
  case unsupported

  var message: String {
    switch self {
    case .invalidArguments: return "PHOTO_LIBRARY_INVALID_ARGUMENTS"
    case .authorizationRequired: return "PHOTO_LIBRARY_AUTHORIZATION_REQUIRED"
    case .authorizationUnavailable: return "PHOTO_LIBRARY_UNAVAILABLE"
    case .albumNotLinked: return "PHOTO_ALBUM_NOT_LINKED"
    case .albumNotAccessible: return "PHOTO_ALBUM_NOT_ACCESSIBLE"
    case .assetNotFound: return "PHOTO_ASSET_NOT_FOUND"
    case .assetNotInAlbum: return "PHOTO_ASSET_NOT_IN_ALBUM"
    case .imageUnavailable: return "PHOTO_IMAGE_UNAVAILABLE"
    case .imageInCloud: return "PHOTO_IN_ICLOUD"
    case .imageTimedOut: return "PHOTO_IMAGE_TIMEOUT"
    case .imageCancelled: return "PHOTO_IMAGE_CANCELLED"
    case .imageEncodingFailed: return "PHOTO_IMAGE_ENCODING_FAILED"
    case .unsupported: return "PHOTO_LIBRARY_IOS_VERSION_UNSUPPORTED"
    }
  }
}

private let photoLibraryLinkedAlbumIDsKey = "com.windsheep.gai.photo-library.linked-album-ids"

private struct PhotoLibraryStatusArgs: Decodable {
  let requestAuthorization: Bool

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    requestAuthorization = try container.decodeIfPresent(Bool.self, forKey: .requestAuthorization) ?? false
  }

  private enum CodingKeys: String, CodingKey {
    case requestAuthorization
  }
}

private struct LinkedPhotoAlbumsArgs: Decodable {
  let albumIDs: [String]

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    albumIDs = try container.decode([String].self, forKey: .albumIDs)
  }

  private enum CodingKeys: String, CodingKey {
    case albumIDs = "albumIds"
  }
}

private struct PhotoAssetImageArgs: Decodable {
  let albumID: String
  let assetID: String
  let thumbnail: Bool
  let allowNetwork: Bool

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    albumID = try container.decode(String.self, forKey: .albumID)
    assetID = try container.decode(String.self, forKey: .assetID)
    thumbnail = try container.decode(Bool.self, forKey: .thumbnail)
    allowNetwork = try container.decodeIfPresent(Bool.self, forKey: .allowNetwork) ?? false
  }

  private enum CodingKeys: String, CodingKey {
    case albumID = "albumId"
    case assetID = "assetId"
    case thumbnail
    case allowNetwork
  }
}

private struct PhotoAssetReference {
  let identifier: String
  let creationDate: Date?
}

private struct PhotoAlbumReference {
  let identifier: String
  let title: String
  let count: Int
}

private final class PhotoLibraryCache {
  static let shared = PhotoLibraryCache()

  private let fileManager = FileManager.default
  private let cacheQueue = DispatchQueue(label: "com.windsheep.gai.photo-library.cache", qos: .utility)
  private let maxBytes: UInt64 = 128 * 1024 * 1024
  private var generation: UInt64 = 0
  // FileManager.cachesDirectory resolves to the app sandbox's Library/Caches.
  // Keep all generated files below this dedicated root so the Rust side can
  // validate returned paths without accepting arbitrary filesystem paths.
  private let directoryName = "GAIPhotoLibrary"

  private init() {}

  func currentGeneration() -> UInt64 {
    cacheQueue.sync { generation }
  }

  func cachedImage(for key: String, assetID: String) -> URL? {
    cacheQueue.sync {
      guard let directory = ensureDirectory() else { return nil }
      let url = directory.appendingPathComponent(cacheFileName(for: key, assetID: assetID), isDirectory: false)
      guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
            (values.fileSize ?? 0) > 0 else {
        return nil
      }
      try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
      return url
    }
  }

  func storeJPEG(_ data: Data, for key: String, assetID: String) -> URL? {
    storeJPEG(data, for: key, assetID: assetID, expectedGeneration: nil)
  }

  func storeJPEG(
    _ data: Data,
    for key: String,
    assetID: String,
    expectedGeneration: UInt64?
  ) -> URL? {
    cacheQueue.sync {
      if let expectedGeneration, expectedGeneration != generation {
        return nil
      }
      guard let directory = ensureDirectory() else { return nil }
      let url = directory.appendingPathComponent(cacheFileName(for: key, assetID: assetID), isDirectory: false)
      do {
        try data.write(to: url, options: [.atomic])
        try fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        trimIfNeeded(in: directory)
        return url
      } catch {
        return nil
      }
    }
  }

  /// Remove cached image variants for an asset. This only touches the private cache directory.
  func removeAssets(_ assetIDs: Set<String>) {
    guard !assetIDs.isEmpty else { return }
    cacheQueue.sync {
      generation &+= 1
      guard let directory = self.ensureDirectory(),
            let urls = try? self.fileManager.contentsOfDirectory(
              at: directory,
              includingPropertiesForKeys: nil,
              options: [.skipsHiddenFiles]
            ) else {
        return
      }

      let prefixes = Set(assetIDs.map { self.assetPrefix(for: $0) + "_" })
      for url in urls where prefixes.contains(where: { url.lastPathComponent.hasPrefix($0) }) {
        try? self.fileManager.removeItem(at: url)
      }
    }
  }

  /// Remove cached variants whose asset is no longer in any currently visible
  /// linked album. Hash prefixes keep the cache opaque while allowing this
  /// membership reconciliation to work across app launches.
  func removeAssetsNotIn(_ assetIDs: Set<String>) {
    cacheQueue.sync {
      guard let directory = self.ensureDirectory(),
            let urls = try? self.fileManager.contentsOfDirectory(
              at: directory,
              includingPropertiesForKeys: nil,
              options: [.skipsHiddenFiles]
            ) else {
        return
      }

      let prefixes = Set(assetIDs.map { self.assetPrefix(for: $0) })
      var removedAny = false
      for url in urls {
        let cacheAssetPrefix = url.lastPathComponent
          .split(separator: "_", maxSplits: 1, omittingEmptySubsequences: false)
          .first
          .map(String.init)
        guard let cacheAssetPrefix, prefixes.contains(cacheAssetPrefix) else {
          if (try? self.fileManager.removeItem(at: url)) != nil {
            removedAny = true
          }
          continue
        }
      }
      if removedAny {
        generation &+= 1
      }
    }
  }

  /// Remove every generated file below the private cache root. This is used
  /// when permission revocation or an unavailable album makes asset membership
  /// unknowable. It never touches the user's Photos library.
  func removeAll() {
    cacheQueue.sync {
      generation &+= 1
      guard let directory = self.ensureDirectory(),
            let urls = try? self.fileManager.contentsOfDirectory(
              at: directory,
              includingPropertiesForKeys: nil,
              options: [.skipsHiddenFiles]
            ) else {
        return
      }
      for url in urls {
        try? self.fileManager.removeItem(at: url)
      }
    }
  }

  private func ensureDirectory() -> URL? {
    guard let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      return nil
    }
    let directory = caches.appendingPathComponent(directoryName, isDirectory: true)
    do {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
      return directory
    } catch {
      return nil
    }
  }

  private func cacheFileName(for key: String, assetID: String) -> String {
    "\(assetPrefix(for: assetID))_\(key)"
  }

  private func assetPrefix(for assetID: String) -> String {
    sha256Hex(assetID).prefix(24).description
  }

  private func trimIfNeeded(in directory: URL) {
    guard let urls = try? fileManager.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
      options: [.skipsHiddenFiles]
    ) else {
      return
    }

    var entries: [(url: URL, size: UInt64, date: Date)] = []
    var total: UInt64 = 0
    for url in urls {
      guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
            let fileSize = values.fileSize else {
        continue
      }
      total += UInt64(fileSize)
      entries.append((url, UInt64(fileSize), values.contentModificationDate ?? .distantPast))
    }

    guard total > maxBytes else { return }
    entries.sort { $0.date < $1.date }
    for entry in entries where total > maxBytes {
      try? fileManager.removeItem(at: entry.url)
      total = total > entry.size ? total - entry.size : 0
    }
  }

  private func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

private final class PhotoImageRequestCoordinator {
  static let shared = PhotoImageRequestCoordinator()

  private struct Waiter {
    let resolve: (URL) -> Void
    let reject: (PhotoLibraryBridgeError) -> Void
  }

  private final class PendingRequest {
    let key: String
    let asset: PHAsset
    let targetSize: CGSize
    let maxDimension: CGFloat
    let allowNetwork: Bool
    let cacheGeneration: UInt64
    var waiters: [Waiter] = []
    var requestID: PHImageRequestID?
    var timeoutWorkItem: DispatchWorkItem?
    var finished = false

    init(
      key: String,
      asset: PHAsset,
      targetSize: CGSize,
      maxDimension: CGFloat,
      allowNetwork: Bool,
      cacheGeneration: UInt64,
      waiter: Waiter
    ) {
      self.key = key
      self.asset = asset
      self.targetSize = targetSize
      self.maxDimension = maxDimension
      self.allowNetwork = allowNetwork
      self.cacheGeneration = cacheGeneration
      self.waiters = [waiter]
    }
  }

  private let queue = DispatchQueue(label: "com.windsheep.gai.photo-library.requests", qos: .userInitiated)
  private var activeCount = 0
  private var pendingByKey: [String: PendingRequest] = [:]
  private let maximumConcurrentRequests = 2
  private let timeout: TimeInterval = 30

  private init() {}

  func enqueue(
    key: String,
    asset: PHAsset,
    targetSize: CGSize,
    maxDimension: CGFloat,
    allowNetwork: Bool,
    cacheGeneration: UInt64,
    resolve: @escaping (URL) -> Void,
    reject: @escaping (PhotoLibraryBridgeError) -> Void
  ) {
    queue.async {
      let waiter = Waiter(resolve: resolve, reject: reject)
      if let existing = self.pendingByKey[key] {
        existing.waiters.append(waiter)
      } else {
        self.pendingByKey[key] = PendingRequest(
          key: key,
          asset: asset,
          targetSize: targetSize,
          maxDimension: maxDimension,
          allowNetwork: allowNetwork,
          cacheGeneration: cacheGeneration,
          waiter: waiter
        )
      }
      self.startAvailableRequests()
    }
  }

  private func startAvailableRequests() {
    while activeCount < maximumConcurrentRequests,
          let request = pendingByKey.values.first(where: { !$0.finished && $0.requestID == nil }) {
      activeCount += 1
      start(request)
    }
  }

  private func start(_ request: PendingRequest) {
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.version = .current
    options.isSynchronous = false
    options.isNetworkAccessAllowed = request.allowNetwork

    let timeoutWorkItem = DispatchWorkItem { [weak self, weak request] in
      guard let self = self, let request = request else { return }
      self.queue.async {
        guard !request.finished else { return }
        if let requestID = request.requestID {
          PHImageManager.default().cancelImageRequest(requestID)
        }
        self.finish(request, result: .failure(.imageTimedOut))
      }
    }
    request.timeoutWorkItem = timeoutWorkItem

    request.requestID = PHImageManager.default().requestImage(
      for: request.asset,
      targetSize: request.targetSize,
      contentMode: .aspectFit,
      options: options
    ) { [weak self, weak request] image, info in
      guard let self = self, let request = request else { return }
      self.queue.async {
        guard !request.finished else { return }
        let resultInfo = info ?? [:]
        if (resultInfo[PHImageCancelledKey] as? Bool) == true {
          self.finish(request, result: .failure(.imageCancelled))
          return
        }
        if let error = resultInfo[PHImageErrorKey] as? Error {
          self.finish(
            request,
            result: .failure(self.mapImageError(error, info: resultInfo, allowNetwork: request.allowNetwork))
          )
          return
        }
        if (resultInfo[PHImageResultIsDegradedKey] as? Bool) == true {
          return
        }
        if image == nil {
          if (resultInfo[PHImageResultIsInCloudKey] as? Bool) == true && !request.allowNetwork {
            self.finish(request, result: .failure(.imageInCloud))
          } else {
            self.finish(request, result: .failure(.imageUnavailable))
          }
          return
        }
        self.finish(request, result: self.writeImage(image!, request: request))
      }
    }
    queue.asyncAfter(deadline: .now() + timeout, execute: timeoutWorkItem)
  }

  private func finish(_ request: PendingRequest, result: Result<URL, PhotoLibraryBridgeError>) {
    guard !request.finished else { return }
    request.finished = true
    request.timeoutWorkItem?.cancel()
    pendingByKey.removeValue(forKey: request.key)
    activeCount = max(0, activeCount - 1)

    let waiters = request.waiters
    request.waiters.removeAll()
    for waiter in waiters {
      switch result {
      case .success(let url): waiter.resolve(url)
      case .failure(let error): waiter.reject(error)
      }
    }
    startAvailableRequests()
  }

  private func writeImage(_ image: UIImage, request: PendingRequest) -> Result<URL, PhotoLibraryBridgeError> {
    guard PhotoLibraryCache.shared.currentGeneration() == request.cacheGeneration else {
      return .failure(.imageCancelled)
    }
    guard let normalized = normalizedImage(image, maxDimension: request.maxDimension),
          let jpeg = normalized.jpegData(compressionQuality: 0.88) else {
      return .failure(.imageEncodingFailed)
    }

    let modification = request.asset.modificationDate?.timeIntervalSince1970 ?? 0
    let sizeToken = "\(Int(request.maxDimension))"
    let sourceKey = "\(request.asset.localIdentifier)|\(modification)|\(sizeToken)"
    let cacheKey = sha256Hex(sourceKey)
    if let existing = PhotoLibraryCache.shared.cachedImage(for: cacheKey, assetID: request.asset.localIdentifier) {
      return .success(existing)
    }
    guard let url = PhotoLibraryCache.shared.storeJPEG(
      jpeg,
      for: cacheKey,
      assetID: request.asset.localIdentifier,
      expectedGeneration: request.cacheGeneration
    ) else {
      return .failure(.imageEncodingFailed)
    }
    return .success(url)
  }

  private func normalizedImage(_ image: UIImage, maxDimension: CGFloat) -> UIImage? {
    guard image.size.width > 0, image.size.height > 0 else { return nil }
    let scale = min(1, maxDimension / max(image.size.width, image.size.height))
    let size = CGSize(width: max(1, floor(image.size.width * scale)), height: max(1, floor(image.size.height * scale)))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private func mapImageError(
    _ error: Error,
    info: [AnyHashable: Any],
    allowNetwork: Bool
  ) -> PhotoLibraryBridgeError {
    if !allowNetwork,
       (info[PHImageResultIsInCloudKey] as? Bool) == true,
       !((info[PHImageCancelledKey] as? Bool) == true) {
      return .imageInCloud
    }
    if (error as NSError).code == NSUserCancelledError {
      return .imageCancelled
    }
    return .imageUnavailable
  }

  private func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

@available(iOS 15.0, *)
private final class PhotoLibraryBridge {
  static let shared = PhotoLibraryBridge()

  private let operationQueue = DispatchQueue(label: "com.windsheep.gai.photo-library.operations", qos: .userInitiated)
  private let defaults = UserDefaults.standard

  private init() {}

  func status(requestAuthorization: Bool, completion: @escaping ([String: Any]) -> Void) {
    if requestAuthorization {
      DispatchQueue.main.async {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
          self.operationQueue.async {
            completion(self.statusPayload())
          }
        }
      }
    } else {
      operationQueue.async {
        completion(self.statusPayload())
      }
    }
  }

  func setLinkedAlbums(_ albumIDs: [String], completion: @escaping (Result<[String: Any], PhotoLibraryBridgeError>) -> Void) {
    operationQueue.async {
      guard albumIDs.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
            Set(albumIDs).count == albumIDs.count else {
        completion(.failure(.invalidArguments))
        return
      }

      let previous = self.linkedAlbumIDs()
      let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
      let available = self.availableAlbumIDs(for: status)
      let additions = Set(albumIDs).subtracting(previous)
      let canAdd = status == .authorized || status == .limited
        ? additions.isSubset(of: available)
        : additions.isEmpty
      guard canAdd else {
        completion(.failure(status == .authorized || status == .limited ? .albumNotAccessible : .authorizationRequired))
        return
      }

      // Existing linked IDs remain representable while access is lost. This
      // lets the caller explicitly remove them (including while denied) and
      // preserves them for unavailable=false snapshots until then.
      self.defaults.set(albumIDs, forKey: photoLibraryLinkedAlbumIDsKey)

      let removed = Set(previous).subtracting(albumIDs)
      if !removed.isEmpty {
        if status == .authorized || status == .limited {
          let unavailableRemoved = removed.subtracting(available)
          if unavailableRemoved.isEmpty {
            let removedAssetIDs = self.assetIDs(for: removed, status: status)
            PhotoLibraryCache.shared.removeAssets(removedAssetIDs)
          } else {
            PhotoLibraryCache.shared.removeAll()
          }
        } else {
          PhotoLibraryCache.shared.removeAll()
        }
      }

      completion(.success([
        "authorization": self.authorizationString(status),
        "linkedAlbumIds": albumIDs
      ]))
    }
  }

  func snapshots(completion: @escaping ([String: Any]) -> Void) {
    operationQueue.async {
      completion(self.snapshotPayload())
    }
  }

  func image(
    albumID: String,
    assetID: String,
    thumbnail: Bool,
    allowNetwork: Bool,
    resolve: @escaping (URL) -> Void,
    reject: @escaping (PhotoLibraryBridgeError) -> Void
  ) {
    operationQueue.async {
      guard !albumID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !assetID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        reject(.invalidArguments)
        return
      }

      let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
      guard status == .authorized || status == .limited else {
        reject(.authorizationRequired)
        return
      }

      let linked = self.linkedAlbumIDs()
      guard linked.contains(albumID) else {
        reject(.albumNotLinked)
        return
      }

      guard let asset = self.asset(assetID, inAlbum: albumID, status: status) else {
        reject(.assetNotInAlbum)
        return
      }

      let maxDimension: CGFloat = thumbnail ? 512 : 4096
      let targetSize: CGSize
      if asset.pixelWidth > 0, asset.pixelHeight > 0 {
        let scale = min(1, maxDimension / CGFloat(max(asset.pixelWidth, asset.pixelHeight)))
        targetSize = CGSize(
          width: max(1, floor(CGFloat(asset.pixelWidth) * scale)),
          height: max(1, floor(CGFloat(asset.pixelHeight) * scale))
        )
      } else {
        targetSize = CGSize(width: maxDimension, height: maxDimension)
      }

      let modification = asset.modificationDate?.timeIntervalSince1970 ?? 0
      let sourceKey = "\(asset.localIdentifier)|\(modification)|\(Int(maxDimension))"
      let cacheKey = self.sha256Hex(sourceKey)
      if let cached = PhotoLibraryCache.shared.cachedImage(for: cacheKey, assetID: asset.localIdentifier) {
        guard self.currentAssetIfReadable(assetID: assetID, albumID: albumID) != nil else {
          reject(self.unreadableAssetError(assetID: assetID, albumID: albumID))
          return
        }
        resolve(cached)
        return
      }

      PhotoImageRequestCoordinator.shared.enqueue(
        key: "\(cacheKey)|network:\(allowNetwork)",
        asset: asset,
        targetSize: targetSize,
        maxDimension: maxDimension,
        allowNetwork: allowNetwork,
        cacheGeneration: PhotoLibraryCache.shared.currentGeneration(),
        resolve: { [weak self] url in
          guard let self = self else { return }
          self.operationQueue.async {
            guard let currentAsset = self.currentAssetIfReadable(
              assetID: assetID,
              albumID: albumID
            ) else {
              PhotoLibraryCache.shared.removeAssets([assetID])
              reject(self.unreadableAssetError(assetID: assetID, albumID: albumID))
              return
            }
            // The re-fetch above also proves the current authorization range
            // and album membership; use it only as a validity gate. The
            // already-rendered JPEG remains in the private cache.
            _ = currentAsset
            resolve(url)
          }
        },
        reject: reject
      )
    }
  }

  private func statusPayload() -> [String: Any] {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    var albums: [[String: Any]] = []
    if status == .authorized {
      albums = albumDescriptors().map {
        ["id": $0.identifier, "title": $0.title, "count": $0.count]
      }
      albums.insert(photoLibraryDescriptor(), at: 0)
    } else if status == .limited {
      albums = [[
        "id": "limited-library",
        "title": "已選照片（有限存取）",
        "count": PHAsset.fetchAssets(with: .image, options: nil).count
      ]]
    }

    return [
      "authorization": authorizationString(status),
      "albums": albums,
      "linkedAlbumIds": linkedAlbumIDs()
    ]
  }

  private func snapshotPayload() -> [String: Any] {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    let linked = linkedAlbumIDs()
    var currentAssetIDs = Set<String>()
    let albums: [[String: Any]] = linked.map { identifier in
      guard status == .authorized || status == .limited else {
        return ["id": identifier, "title": "相簿目前不可用", "available": false, "assetIds": []]
      }

      if status == .limited {
        guard identifier == "limited-library" else {
          return ["id": identifier, "title": "相簿目前不可用（有限存取）", "available": false, "assetIds": []]
        }
        let assets = sortedAssetReferences(PHAsset.fetchAssets(with: .image, options: nil))
        currentAssetIDs.formUnion(assets.map(\.identifier))
        return [
          "id": identifier,
          "title": "已選照片（有限存取）",
          "available": true,
          "assetIds": assets.map(\.identifier)
        ]
      }

      if identifier == "photo-library" {
        let assets = sortedAssetReferences(PHAsset.fetchAssets(with: .image, options: nil))
        currentAssetIDs.formUnion(assets.map(\.identifier))
        return [
          "id": identifier,
          "title": "所有照片（照片圖庫）",
          "available": true,
          "assetIds": assets.map(\.identifier)
        ]
      }

      let collections = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [identifier], options: nil)
      guard let collection = collections.firstObject else {
        return ["id": identifier, "title": "相簿目前不可用", "available": false, "assetIds": []]
      }
      let assets = sortedAssetReferences(PHAsset.fetchAssets(in: collection, options: imageFetchOptions()))
      currentAssetIDs.formUnion(assets.map(\.identifier))
      return [
        "id": identifier,
        "title": collection.localizedTitle ?? "未命名相簿",
        "available": true,
        "assetIds": assets.map(\.identifier)
      ]
    }

    if status == .authorized || status == .limited {
      PhotoLibraryCache.shared.removeAssetsNotIn(currentAssetIDs)
    } else {
      // When authorization is denied/restricted, membership is unknowable;
      // clear the whole private cache rather than trusting an old membership.
      PhotoLibraryCache.shared.removeAll()
    }

    return [
      "authorization": authorizationString(status),
      "albums": albums
    ]
  }

  private func albumDescriptors() -> [PhotoAlbumReference] {
    let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
    var descriptors: [PhotoAlbumReference] = []
    for index in 0..<collections.count {
      let collection = collections.object(at: index)
      let title = collection.localizedTitle ?? "未命名相簿"
      let count = PHAsset.fetchAssets(in: collection, options: imageFetchOptions()).count
      descriptors.append(PhotoAlbumReference(identifier: collection.localIdentifier, title: title, count: count))
    }
    return descriptors.sorted {
      if $0.title.localizedStandardCompare($1.title) == .orderedSame {
        return $0.identifier < $1.identifier
      }
      return $0.title.localizedStandardCompare($1.title) == .orderedAscending
    }
  }

  private func photoLibraryDescriptor() -> [String: Any] {
    [
      "id": "photo-library",
      "title": "所有照片（照片圖庫）",
      "count": PHAsset.fetchAssets(with: .image, options: nil).count
    ]
  }

  private func availableAlbumIDs(for status: PHAuthorizationStatus) -> Set<String> {
    if status == .limited {
      return ["limited-library"]
    }
    guard status == .authorized else { return [] }
    var IDs = Set(albumDescriptors().map(\.identifier))
    IDs.insert("photo-library")
    return IDs
  }

  private func assetIDs(for albumIDs: Set<String>, status: PHAuthorizationStatus) -> Set<String> {
    var result = Set<String>()
    for albumID in albumIDs {
      if status == .limited, albumID == "limited-library" {
        result.formUnion(sortedAssetReferences(PHAsset.fetchAssets(with: .image, options: nil)).map(\.identifier))
      } else if status == .authorized, albumID == "photo-library" {
        result.formUnion(sortedAssetReferences(PHAsset.fetchAssets(with: .image, options: nil)).map(\.identifier))
      } else if status == .authorized,
                let collection = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumID], options: nil).firstObject {
        result.formUnion(sortedAssetReferences(PHAsset.fetchAssets(in: collection, options: imageFetchOptions())).map(\.identifier))
      }
    }
    return result
  }

  private func asset(_ assetID: String, inAlbum albumID: String, status: PHAuthorizationStatus) -> PHAsset? {
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject,
          asset.mediaType == .image else {
      return nil
    }

    if status == .limited && albumID == "limited-library" {
      return asset
    }
    if status == .authorized && albumID == "photo-library" {
      return asset
    }
    guard status == .authorized,
          let collection = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumID], options: nil).firstObject else {
      return nil
    }
    let assets = PHAsset.fetchAssets(in: collection, options: imageFetchOptions())
    for index in 0..<assets.count {
      let candidate = assets.object(at: index)
      if candidate.localIdentifier == assetID {
        return candidate
      }
    }
    return nil
  }

  private func currentAssetIfReadable(assetID: String, albumID: String) -> PHAsset? {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard (status == .authorized || status == .limited),
          linkedAlbumIDs().contains(albumID) else {
      return nil
    }
    return asset(assetID, inAlbum: albumID, status: status)
  }

  private func unreadableAssetError(assetID: String, albumID: String) -> PhotoLibraryBridgeError {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status != .authorized && status != .limited {
      return .authorizationRequired
    }
    if !linkedAlbumIDs().contains(albumID) {
      return .albumNotLinked
    }
    if PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject == nil {
      return .assetNotFound
    }
    return .assetNotInAlbum
  }

  private func linkedAlbumIDs() -> [String] {
    defaults.stringArray(forKey: photoLibraryLinkedAlbumIDsKey) ?? []
  }

  private func authorizationString(_ status: PHAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "full"
    case .limited: return "limited"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  private func imageFetchOptions() -> PHFetchOptions {
    let options = PHFetchOptions()
    options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    return options
  }

  private func sortedAssetReferences(_ assets: PHFetchResult<PHAsset>) -> [PhotoAssetReference] {
    var references: [PhotoAssetReference] = []
    references.reserveCapacity(assets.count)
    for index in 0..<assets.count {
      let asset = assets.object(at: index)
      guard asset.mediaType == .image else { continue }
      references.append(PhotoAssetReference(identifier: asset.localIdentifier, creationDate: asset.creationDate))
    }
    return references.sorted {
      let lhs = $0.creationDate ?? .distantPast
      let rhs = $1.creationDate ?? .distantPast
      if lhs == rhs { return $0.identifier < $1.identifier }
      return lhs < rhs
    }
  }

  private func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - ExamplePlugin PhotoKit extension

extension ExamplePlugin {
  @objc public func photoLibraryStatus(_ invoke: Invoke) throws {
    guard #available(iOS 15.0, *) else {
      invoke.reject(PhotoLibraryBridgeError.unsupported.message)
      return
    }
    do {
      let args = try invoke.parseArgs(PhotoLibraryStatusArgs.self)
      PhotoLibraryBridge.shared.status(requestAuthorization: args.requestAuthorization) { payload in
        invoke.resolve(payload)
      }
    } catch {
      invoke.reject(PhotoLibraryBridgeError.invalidArguments.message)
    }
  }

  @objc public func setLinkedPhotoAlbums(_ invoke: Invoke) throws {
    guard #available(iOS 15.0, *) else {
      invoke.reject(PhotoLibraryBridgeError.unsupported.message)
      return
    }
    do {
      let args = try invoke.parseArgs(LinkedPhotoAlbumsArgs.self)
      PhotoLibraryBridge.shared.setLinkedAlbums(args.albumIDs) { result in
        switch result {
        case .success(let payload): invoke.resolve(payload)
        case .failure(let error): invoke.reject(error.message)
        }
      }
    } catch {
      invoke.reject(PhotoLibraryBridgeError.invalidArguments.message)
    }
  }

  @objc public func linkedPhotoAlbumSnapshots(_ invoke: Invoke) throws {
    guard #available(iOS 15.0, *) else {
      invoke.reject(PhotoLibraryBridgeError.unsupported.message)
      return
    }
    PhotoLibraryBridge.shared.snapshots { payload in
      invoke.resolve(payload)
    }
  }

  @objc public func photoAssetImage(_ invoke: Invoke) throws {
    guard #available(iOS 15.0, *) else {
      invoke.reject(PhotoLibraryBridgeError.unsupported.message)
      return
    }
    do {
      let args = try invoke.parseArgs(PhotoAssetImageArgs.self)
      PhotoLibraryBridge.shared.image(
        albumID: args.albumID,
        assetID: args.assetID,
        thumbnail: args.thumbnail,
        allowNetwork: args.allowNetwork,
        resolve: { url in
          invoke.resolve(["path": url.path, "mimeType": "image/jpeg"])
        },
        reject: { error in
          invoke.reject(error.message)
        }
      )
    } catch {
      invoke.reject(PhotoLibraryBridgeError.invalidArguments.message)
    }
  }
}
