# Judgment Overlay — Mojidori（最後查證日期：2026-09-04）

本 repo 專屬判準（危險域、驗證指令、權限特例、教訓寫回），由 repo 根目錄 CLAUDE.md 正式引用；通用規則見全域 `~/.claude/CLAUDE.md`。內容更新時同步上方查證日期；若本檔與 repo 根目錄 CLAUDE.md 衝突，以該檔為準並更新本檔。

## 1. 危險域清單

Mojidori 是本機文字編輯器，「使用者檔案的資料完整性」等同其他專案的金流——默默毀損內容是最貴的錯誤：

- 儲存路徑：原子寫入（暫存檔＋rename）、hot exit 的備份/還原邏輯。
- 編碼/換行/BOM 的 decode–encode round-trip；decode error 必須呈現給使用者，絕不默默當正常文字渲染（ARCHITECTURE.md 硬約束）。
- IPC 邊界：所有磁碟 I/O 只在 Rust core，raw bytes 不得跨 IPC（ARCHITECTURE.md 硬約束）。
- large-file mode 的 offset 計算：CM6 的 chars 與檔案 bytes 是兩種單位，絕不可混用（2026-06 開發期真實教訓）。
- Release／tag／發佈：pre-release tag＋draft release 依 2026-07-15 使用者委任可自主；正式 publish、yank、刪除 tag 仍為對外動作，一律先問。

## 2. 驗證指令表

真相來源是 CLAUDE.md「Definition of done」#1–#4（該檔每 session 常駐，指令不在此復述）：

| 變更觸及 | 最低驗證 |
| --- | --- |
| 任何程式碼變更 | DoD #1（前端）＋ #2（Rust）全套 |
| encoding 行為 | 另必含 round-trip 測試，新增或更新（DoD #3） |
| 不需 WebView 的前端邏輯（tab store、pure helpers） | 對應 `src/*.test.ts` 單元測試（DoD #3） |
| 任何 PR | ROADMAP.md checkbox 同 PR 更新（DoD #4） |

環境細節：cargo 指令莫名失敗時，先檢查 CLAUDE.md Commands 註記的 fresh-clone `dist/` gotcha，不是程式碼的錯。

## 3. 檔案權限增補

- Green：`src/`、`src-tauri/` 範圍內 code＋tests（feature branch）；同 PR 勾 ROADMAP.md checkbox；本檔（judgment-overlay.md）的教訓寫回。
- Yellow（先提案）：ARCHITECTURE.md（硬約束文件）；新增任何 runtime dependency（CLAUDE.md 明定需強理由）；DIRECTION.md 的方向性內容（決策關卡、階段計畫——2026-07-08 應使用者要求建立，內含完整策略、情境對策與 session 交接協定；把 §6 backlog 項目升級進 ROADMAP 需使用者簽核）。
- Red：發佈 release／刪 tag；改變 repo visibility（**2026-07-15 起使用者裁示為 public**——CI 免費＋時機認可；再改回 private 或任何 visibility 變更都要使用者當次明示）；在任何對外文字提及 Notepad++（定位紅線——repo 已公開，全檔案皆對外，此線更嚴，不因改名解除）；正式命名（D1）已於 2026-07-23 定案為「Mojidori」，可對外使用；「Plume」自此僅為歷史開發代號，新對外文字不應再用它自稱產品。

## 4. 教訓寫回目標

- repo 專屬 ops 規則／死路 → 本檔對應節。
- 專案狀態交接、個人偏好 → auto-memory 目錄（現有：`plume-session-1-status`、`plume-positioning-constraints`、`gh-pr-checks-watch-race`）。
- 技術債 → Mojidori 無獨立 register，記入 ROADMAP.md 相應區塊。

已知死路（動手前先讀）：

- `encoding_rs::Encoding::new_encoder()` 對 UTF-16LE/BE 回傳的其實是 UTF-8 encoder（`output_encoding()` 規則：UTF-16/replacement 的 output encoding 都是 UTF-8）——任何 streaming encode 路徑對 UTF-16 用它會靜默寫出錯誤 bytes；`streamreplace.rs` 因此顯式拒絕 UTF-16，未來新增 streaming-encode 功能前先查這條（streamreplace.rs 模組註解，2026-07-12）。
- `gh pr checks --watch` 在 PR 剛建立時會誤報通過——先輪詢 check 註冊完成再 watch（memory：gh-pr-checks-watch-race）。
- 選單建構必須在 Tauri `setup()` 內（PathResolver state 順序）；啟動期 panic 要靠啟動煙霧測試抓，CI 一般測試抓不到（memory：plume-session-1-status）。
- GH Actions macOS runner 跑不了需要 WKWebView 實際載入的測試：native setup 正常完成後 WebView 永不開始載入頁面（`on_page_load` Started 不觸發；Aqua session 存在、ad-hoc codesign 無效，root cause 未定；本機鎖屏時同症狀）。startup bench 只能在解鎖的互動桌面本機跑，勿再嘗試 CI 化（PR #38，2026-07-10）。
- 用 Unicode general category 當行為代理（如 `\p{M}` 當「可與前字合成」）會漏非 Mark 的 composition 二元素（Hangul V/T jamo、U+16D67 都是 Lo）——正解是 UAX #15 normalization boundary＋以 runtime 自己的 `normalize` 對 planes 0–2 全分解字元掃描驗證，手挑 fixture 的測試綠燈抓不到（normalize.ts，critic 審查抓到，2026-07-15）。
- Windows 對目錄的 readonly 屬性（`set_readonly(true)`）不阻止在目錄內建立子項——用「鎖父目錄」模擬寫入失敗的測試在 Windows 永遠不會失敗，該類測試 gate `#[cfg(unix)]` 並在註解說明錯誤路徑為平台無關（migrate.rs 遷移測試，Windows CI 抓到，2026-07-23）。
- Windows 的 `sync_all`（`FlushFileBuffers`）需要 write-capable handle——唯讀開啟的 handle 呼叫 `sync_all` 回 `ERROR_ACCESS_DENIED`（os error 5），Unix 的 fsync 無此限制，故此類 bug 只在 Windows CI 現形；正解是用寫入時的同一個 handle 直接 sync，不要 `fs::copy` 完再重新 `File::open`（唯讀）呼叫 `sync_all`（migrate.rs copy helpers，Windows CI 抓到，2026-07-23）。
- Windows 的 `SystemTime` 是 FILETIME（100ns 粒度）：`UNIX_EPOCH ± Duration::new(_, 1)` 這種 1ns 位移在 Windows 靜默截斷、pre-epoch fixture 直接變 epoch——時間類測試 fixture 的次秒位移一律用 100ns 倍數，兩平台皆精確（fsguard EpochOffset 測試，首次真 Windows CI 抓到，2026-07-15）。
- encoding_rs 唯一的 stateful encoder 是 ISO-2022-JP，且 chardetng auto-detect 真實可達——任何 byte-level 快路（chunk passthrough、行級直拷）必須顯式排除它（`enc == ISO_2022_JP`，static singleton identity 可靠）：raw bytes 的 trailing shift-state 會與 encoder 內部 state 脫節，次段 re-encode 漏發 escape，產生 had_errors=false 的靜默內容毀損；「encoder 一律照跑」只同步內部 state、救不了磁碟上的 shift-state（streamreplace passthrough，critic 實跑構造抓到 P1，2026-07-15）。
- chardetng 0.1.17 的候選模型完全沒有 KOI8-R（只有 KOI8-U；原始碼 `SINGLE_BYTE_DATA` 21 個候選無 `KOI8_R_INIT`，README 明載「KOI8-R: Detected as KOI8-U」）——任何依賴 `.guess()` 結果核對某假說是否為 KOI8-R 的邏輯（如 mojibake wizard `try_repair` 的 chardetng gate）永遠不會通過，不是機率低而是結構上不可能；`src/encodings.ts` 的 `MANUAL_ONLY_ENCODINGS` 已記錄同一事實於開檔 auto-detect 端。新增任何以 chardetng 核對「是否為 X 編碼」的偵測/修復假說前，先確認 X 不是 KOI8-R（mojibake.rs `REPAIR_PAIRS`，issue #182，2026-07-16）。
- `mojibake::REPAIR_PAIRS` 與 `fuzz_roundtrip.rs`（`MojibakePools` 欄位／`run_mojibake_reversibility_fuzz` 的 match）是手動同步、非自動衍生——新增或刪除 `REPAIR_PAIRS` 項目若未同步補齊該處的 pool 欄位與 match arm，對應 fuzz 測試會在執行期 panic（`unhandled mojibake::REPAIR_PAIRS entry`），不是編譯期錯誤，肉眼看 `mojibake.rs` 本身抓不到（ROADMAP v0.6 E2 新增 (WINDOWS_1252, EUC_JP) 時實跑 `cargo test` 才發現，2026-07-17）。
- PR 顯示「no checks reported」時先查 `gh pr view N --json mergeable`——GitHub 對 CONFLICTING 的 PR 根本不建 merge ref、pull_request workflow 靜默不觸發，樣子與 Actions 服務停擺一模一樣；rebase 解衝突後 CI 立即恢復。empty commit／close-reopen／重開 PR 都救不了 conflict 造成的 no-checks（v0.7 C4/C5 PR，2026-07-19）。
- `gh pr merge --squash --delete-branch` 在 local branch 被 worktree 佔用時 exit 1：merge 本身成功，但**local 與 remote 兩側的 branch 刪除都不會執行**——清 worktree 後要補 `git branch -D` 與 `git push origin --delete`，並在 session 尾對 `git ls-remote --heads origin` 做總對帳（v0.7 一輪 14 個 remote branch 全數殘留的實測，2026-07-19）。
- chardetng 的候選模型完全沒有 GB18030（只有 GBK；`Gbk` 候選的 `encoding()` 永遠回傳 `GBK`）——任何要求 chardetng 確認某假說為 GB18030 的邏輯結構上不可能通過，與既有 KOI8-R 死路同形（issue #336，v0.9 B1 ranking 閘門實測，2026-07-27）。
- out-of-process hang 回歸測試（`execFileSync` 帶 timeout）的時限不得把 esbuild bundling 等建置開銷算進計時段——bundle 一次的耗時要移出計時區間，否則會以 flake 形式誤殺不相干的 CI（曾誤殺 #331 的 Windows CI）（#334 修正，2026-07-27）。
- auto-mode 權限分類器可能隨機擋下 `gh pr merge`（subagent 與主對話皆可能中）：處置是拆掉複合指令後單獨重試一次，再被擋就停下回報，絕不繞路（v0.9 #335 實例，2026-07-27）。
- CI 用 `dtolnay/rust-toolchain@stable`，Rust 工具鏈會在兩次合併之間靜默升級，新版 clippy lint 在 `-D warnings` 下直接讓 main 紅燈——PR 紅燈（尤其純文件 PR）先查 `gh run list --branch main --limit 3`：若 main 最近一次 run 也紅、失敗步驟是 Rust lint，就是工具鏈漂移，另開 fix PR 先修 main，再對原 PR `gh pr update-branch` 重跑。本機 rustc 通常落後 CI 一至兩版，本機 clippy 全綠不代表 CI 會過（1.98 的 `chunks_exact_to_as_chunks` 擋下 #356，#357 修正，2026-09-04）。
