# build 15 本機與 iPad 交付（2026-09-11）

本輪針對根目錄圖片、iPad 單頁 AI 翻頁與條漫隨讀翻譯修正後，使用同一份 `main` 工作樹完成 Mac／iPad 本機交付。這不是 TestFlight／App Store 上架。

- Git：`132a80bf8e386b4d0736f238968a233149eface3` 已直接推送 `origin/main`；工作樹乾淨。
- iOS：使用本機 APFS staging、Xcode 26.6、Apple Development team `X3UYL4NRRN`，Tauri archive/export 成功，產出 development IPA；版本 `1.0.0`／build `15`。IPA SHA-256：`0f68bcd36895538ef21fec614271728e045c5280291b107aedd85a2985b70925`。
- iPad：目標為已配對的 iPad Air（第 5 代），CoreDevice 回讀 `transportType=localNetwork`、`tunnelState=connected`、`pairingState=paired`；`com.windsheep.gai` 安裝成功、版本回讀 `1.0.0`／bundle version `15`、launch 成功。
- macOS：debug App 已替換至桌面 `/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.app`，保留舊版備份；安裝包已將 `CFBundleVersion` 設為 `15` 並重新 ad-hoc signing，`codesign --verify --deep --strict` 通過。Native accessibility 讀到書架、搜尋欄、資料夾與漫畫項目。執行檔 SHA-256：`18ccbe5d340726990a0e435d352bdbaa205684a0a7ab2a2671ef87404b45c534`。
- Build 陷阱記錄：網路掛載 staging 會讓 Tauri 合併 `Info.plist` 回 `Operation not supported`；改用 `/tmp` 本機 APFS staging 後成功。第一次未帶 development team 的 archive 只失敗在 signing preflight，補上已驗證 team 後成功。
- 尚未宣稱完整 reader acceptance：根目錄圖片實際開啟、iPad 單頁 AI 面板翻頁、條漫等待時間與 AI E2E 仍需主人在 build15 實機操作；本輪證據是編譯、簽章、安裝、版本回讀與啟動。

## Evidence

- [iOS build log](../../output/release/2026-09-11-build15/ios-build-local.log)
- [Mac build log](../../output/release/2026-09-11-build15/mac-build.log)
- [IPA](../../output/release/2026-09-11-build15/GAI-1.0.0-build15-development.ipa)
- [iPad install result](../../output/release/2026-09-11-build15/ipad-install.json)
- [iPad version result](../../output/release/2026-09-11-build15/ipad-version.json)
- [iPad launch result](../../output/release/2026-09-11-build15/ipad-launch.json)
- [Mission Center doctor](../../output/release/2026-09-11-build15/mission-center-doctor.json)
- [Mission Center sync](../../output/release/2026-09-11-build15/mission-center-sync.json)
- [Mission Center status](../../output/release/2026-09-11-build15/mission-center-status.json)
