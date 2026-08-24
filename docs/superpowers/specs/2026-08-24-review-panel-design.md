# AI Review tách thành panel riêng — Design

Ngày: 2026-08-24

## Mục tiêu

Tách kết quả AI review ra khỏi right panel của webview graph, đưa vào một **view
riêng ở bottom Panel** (tab ngang hàng Git Graph và Terminal), với kết quả mở ra
thành **editor tab**. Review chạy dưới quyền extension host: luôn nhìn thấy được,
huỷ được, và không bao giờ sống sót quá vòng đời cửa sổ. Kết quả được **cache theo
cặp sha** của hai nhánh nên chạy lại cùng một cặp commit không tốn tiền lần hai.

## Vấn đề hiện tại

Ba lỗi độc lập, cùng dẫn tới "mất review không lấy lại được".

**1. Click một dòng commit là mất view review — và đường quay lại tự xoá kết quả.**
`handleRowClick` trong `src/webview/App.svelte:441` đặt `rightPanelMode = 'detail'`.
Chỗ duy nhất đặt lại `'review'` là `compareBranches()` ở dòng 1176, nhưng ngay dòng
1177 nó gán `aiReviewResult = null`. Tại thời điểm bị mất, dữ liệu vẫn nằm trong bộ
nhớ webview — chỉ là không còn đường nào chạm tới. Đây không phải "khó quay lại",
mà là **không tồn tại đường quay lại**.

**2. Review là một request chặn, không huỷ được, không giới hạn.**
`ai.review` (`src/extension/extension.ts:331-376`) gọi thẳng
`AIReviewService.review()` rồi chờ tiến trình con kết thúc. Không có cancel, không
có progress, không có streaming. `gitGraphPro.aiReview.timeoutSeconds` mặc định `0`
— nghĩa là **không có trần thời gian**. Nếu webview reload giữa chừng, promise mồ
côi nhưng tiến trình CLI vẫn chạy, vẫn tiêu token, và không còn ai nhận kết quả.

**3. Kết quả chỉ sống trong bộ nhớ webview.** `aiReviewResult` là biến trong
`App.svelte`. Reload webview là mất trắng. File `.md` duy nhất đang được ghi
(`ui.openReviewDocument`) nằm ở `os.tmpdir()` và đặt tên theo **slug tên nhánh**, nên
chạy lại cùng cặp nhánh sẽ **ghi đè** bản cũ, và OS dọn tmp lúc nào không biết.

**Việc chuyển xuống bottom Panel làm lỗi 1 và 2 nặng thêm.** Theo R1 của
`2026-08-24-git-graph-bottom-panel-design.md`, ẩn rồi hiện view sẽ gọi lại
`resolveWebviewView` và dựng lại webview — mà với bottom Panel, **ẩn là trạng thái
mặc định phần lớn thời gian**. Mỗi lần Hide/Show sẽ giết một review đang chạy.

## Quyết định thiết kế

| Quyết định | Lựa chọn |
|---|---|
| Chỗ chứa danh sách | `TreeView` native, viewsContainer riêng ở bottom Panel |
| Chỗ hiển thị nội dung | Editor tab, file `.md` thật dưới `globalStorageUri` |
| Chủ sở hữu tiến trình | Extension host (`ReviewRunner`), không phải webview |
| Khoá cache | `sourceSha` + `targetSha` + `provider` + `model` |
| Độ bền cache | Lâu dài, qua `globalStorageUri`, giữ 50 bản mới nhất mỗi repo |
| Review đang chạy khi rời view | Vẫn chạy, luôn hiện trong danh sách, huỷ được |
| Review đang chạy khi đóng cửa sổ | Bị giết; lần mở sau đánh dấu `interrupted` |
| Chỗ khởi động review | Giữ ở right panel của graph (Compare), chỉ bỏ phần render kết quả |

**Vì sao `TreeView` chứ không phải webview thứ hai.** Một webview list phải tự viết
lại selection, điều hướng bàn phím, context menu và theming — những thứ `TreeView`
cho không. Nội dung thật nằm ở editor tab, nên phần list không cần quyền tạo hình
pixel. Quan trọng hơn: không có webview thứ hai nghĩa là **không dính rủi ro R1**
(re-resolve dựng lại view). GitLens cũng dùng `TreeView` cho đúng loại việc này.

Đánh đổi phải chấp nhận: dòng trong `TreeView` chỉ có `label`, `description`, `icon`.
Không stream được văn bản sống trong dòng — dòng cho biết trạng thái và thời gian đã
trôi; nội dung stream chảy vào document.

## Kiến trúc

### Contribution points (`package.json`)

```jsonc
"viewsContainers": {
  "panel": [
    { "id": "gitGraphPro",       "title": "Git Graph",   "icon": "resources/icon.svg" },
    { "id": "gitGraphProReview", "title": "Code Review", "icon": "resources/review.svg" }
  ]
},
"views": {
  "gitGraphPro":       [{ "type": "webview", "id": "gitGraphPro.graph", "name": "Git Graph",
                          "webviewOptions": { "retainContextWhenHidden": true } }],
  "gitGraphProReview": [{ "id": "gitGraphPro.reviews", "name": "Reviews" }]
}
```

Hai container riêng nên hai tab nằm ngang hàng nhau trên thanh tab của Panel, cạnh
Terminal. `activationEvents` vẫn giữ `[]`: VS Code tự suy ra `onView:` từ contribution.

`resources/review.svg` **chưa tồn tại** — `resources/` hiện chỉ có `icon.png` và
`icon.svg`. Phase 5 phải thêm file này (một glyph đơn sắc dùng `currentColor`, giống
`icon.svg`), nếu không container sẽ hiện icon rỗng.

Lệnh và menu:

```jsonc
"commands": [
  { "command": "gitGraphPro.review.cancel", "title": "Cancel Review",  "icon": "$(stop-circle)" },
  { "command": "gitGraphPro.review.rerun",  "title": "Re-run Review",  "icon": "$(refresh)" },
  { "command": "gitGraphPro.review.delete", "title": "Delete Review",  "icon": "$(trash)" }
],
"menus": {
  "view/item/context": [
    { "command": "gitGraphPro.review.cancel", "when": "view == gitGraphPro.reviews && viewItem == running",  "group": "inline" },
    { "command": "gitGraphPro.review.rerun",  "when": "view == gitGraphPro.reviews && viewItem != running",  "group": "inline" },
    { "command": "gitGraphPro.review.delete", "when": "view == gitGraphPro.reviews && viewItem != running",  "group": "inline" }
  ]
}
```

### `services/review-store.ts`

```
globalStorageUri/reviews/<repoId>/index.json    ReviewEntry[]
globalStorageUri/reviews/<repoId>/<id>.md       nội dung review
```

`repoId = sha256(realpath(repoRoot)).slice(0, 12)` — an toàn cho tên file và ổn định
qua symlink, dùng lại đúng phép canonical hoá mà spec bottom Panel đã chuyển vào
`RepositorySession`.

Quy ước `source`/`target` **giữ đúng như code hiện tại**: `sourceBranch` là **base**,
`targetBranch` là **head**, diff đọc theo `sourceBranch..targetBranch`
(`extension.ts:323-341` dựng payload với `baseBranch: sourceBranch, headBranch:
targetBranch`). Nhãn `main ← feat/graph` nghĩa là base ← head. Đảo hai cái này là đảo
chiều toàn bộ review nên không được đổi tên trường cho "xuôi tai".

```ts
export type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface ReviewEntry {
  id: string;              // `${srcSha7}..${tgtSha7}.${provider}.${model}`
  sourceBranch: string;    // base
  sourceSha: string;
  targetBranch: string;    // head
  targetSha: string;
  provider: string;
  model: string;
  status: ReviewStatus;
  startedAt: string;       // ISO
  finishedAt?: string;
  error?: string;
}
```

API: `list(repoId)`, `get(repoId, id)`, `create(repoId, entry)`, `appendBody(repoId,
id, chunk)`, `finish(repoId, id, patch)`, `remove(repoId, id)`, `bodyUri(repoId, id)`.

**Chuẩn hoá khoá.** `model` có thể rỗng (người dùng để provider tự chọn) — khi đó
dùng chuỗi `default`. `provider` và `model` phải qua `slug()` (`[^\w.-]` → `-`) trước
khi ghép vào `id`, vì tên model hợp lệ vẫn có thể chứa `/` (ví dụ
`anthropic/claude-sonnet-4`) và `id` được dùng trực tiếp làm tên file. Không có bước
này thì `<id>.md` ghi ra ngoài thư mục repo.

Thu hồi: giữ 50 bản mới nhất mỗi repo, xoá cũ nhất trước, **không bao giờ xoá bản
đang `running`**.

### `services/review-runner.ts`

Sở hữu mọi tiến trình con. Nhận `ReviewEntry` chưa chạy, spawn CLI qua
`AIReviewService`, ghi stdout vào body file theo nhịp giới hạn (~1 lần/giây), lật
trạng thái khi tiến trình thoát. Công khai `cancel(id)` và `cancelAll()`.

`AIReviewService.spawnWithStdin` cần thêm một tham số `onChunk?: (text: string) =>
void` để output chảy ra được thay vì chỉ trả về lúc kết thúc. Đây là thay đổi duy
nhất trong service đó.

**Giết tiến trình theo cây, không chỉ tiến trình con trực tiếp** — các CLI này tự
spawn con của chúng. POSIX: `spawn(..., { detached: true })` rồi `process.kill(-pgid,
'SIGTERM')`. Windows: `taskkill /T /F /PID`. Sau SIGTERM chờ 5 giây rồi SIGKILL.
Đây là chỗ dễ sai nhất trong toàn bộ thiết kế nên có test riêng.

`deactivate()` gọi `cancelAll()`. Lúc activate, mọi entry còn `status === 'running'`
trong `index.json` đều là rác — không tiến trình nào sống qua được vòng đời cửa sổ —
nên được ghi lại thành `interrupted`. Đó là trạng thái trung thực; nó không bao giờ
giả vờ là `done`.

### `providers/review-tree-provider.ts`

`implements vscode.TreeDataProvider<ReviewEntry>`.

| Thuộc tính | Giá trị |
|---|---|
| `label` | `main ← feat/graph` |
| `description` | `2m14s` khi đang chạy, `8m ago` khi xong |
| `iconPath` | `$(loading~spin)` / `$(check)` / `$(error)` / `$(circle-slash)` / `$(warning)` |
| `contextValue` | chính là `status`, để `when` của menu bám vào |
| `command` | mở body file |

`onDidChangeTreeData` bắn theo nhịp giới hạn 1 giây khi có review đang chạy, để cột
thời gian trôi mà không làm VS Code dựng lại cây liên tục.

### Điều kiện tiên quyết: hoist `RepositorySession`

`RepositorySession` hiện được dựng bên trong webview provider nên chết theo webview.
Hai view cần chung một repo đang active, nên nó được đưa lên `activate()` và tiêm vào
cả hai. Spec bottom Panel vốn đã gom về một session duy nhất (Task 1 và Task 5), nên
đây là phần việc đó chứ không phải việc phát sinh.

### Đọc nội dung review

Một URI duy nhất, luôn là `file://` dưới `globalStorage`. Khi đang chạy ta append vào
file và VS Code tự nạp lại tab (tab không dirty thì nạp lại im lặng); khi xong thì
file đơn giản là đã đầy đủ.

Đã cân nhắc scheme ảo `git-graph-pro-review:` và **loại**: tab scheme ảo chỉ khôi phục
được sau khi khởi động lại nếu extension đã activate, mà spec bottom Panel cấm
`onStartupFinished`. File thật thì mở được bất kể extension có chạy hay không.

Đánh đổi chấp nhận: trong lúc review stream, tab đang mở nạp lại khoảng mỗi giây nên
con trỏ có thể nhảy nếu người dùng cuộn giữa chừng. Đọc sau khi xong thì không ảnh hưởng.

## Luồng dữ liệu

Namespace `ai.review` (chặn, trả kết quả) được thay bằng namespace `review.*` trả về
ngay lập tức:

```
review.start { sourceBranch, targetBranch, provider, model }
  → git rev-parse cả hai nhánh              → sourceSha, targetSha
  → id = `${src7}..${tgt7}.${provider}.${model}`
  → trúng cache và status 'done'?           → reveal dòng, mở document, KHÔNG spawn
  → không thì tạo entry 'running', spawn, trả { id }      // gần như tức thì
```

Các method còn lại: `review.list`, `review.cancel`, `review.delete`, `review.rerun`,
`review.open`. Router đăng ký thêm `router.register('review', ...)`.

Trúng cache chính là phần lợi chính: cùng cặp commit, cùng model thì không tốn tiền
lần thứ hai. Nhánh dịch chuyển → sha đổi → khoá đổi → miss, nên không bao giờ đọc phải
review cũ của code khác.

**Chỗ khởi động vẫn nằm ở graph.** Right panel giữ nguyên chế độ Compare — chọn nhánh,
xem danh sách file đổi, mở diff — vì đó là việc gắn liền với graph. Nút Review giờ chỉ
tạo job rồi focus sang tab review. Thứ bị bỏ đi là phần **render kết quả**.

**Không thêm QuickPick launcher trên review view.** Lệnh Re-run trên từng dòng đã phủ
nhu cầu chạy lại, còn một luồng khởi động thứ hai là thêm một chỗ phải giữ đồng bộ cho
một tình huống có thể không bao giờ xảy ra. Thêm sau vẫn dễ.

**Diff rỗng** (`target == source`, hoặc không có thay đổi) thì không tạo entry, chỉ báo
lại. Danh sách đầy những dòng "no differences" không giúp được ai.

## Xử lý lỗi

Mọi kiểu hỏng đều kết thúc thành **một dòng mở ra xem được**, không bao giờ mất im lặng.

| Tình huống | Kết quả |
|---|---|
| Thiếu CLI / provider không khả dụng | `failed`, lỗi ghi vào `error` **và** vào body file |
| Tiến trình thoát khác 0 | `failed`, phần đuôi stderr được ghi lại |
| Hết hạn im lặng (`timeoutSeconds`) | `failed`, thông báo nêu đúng tên setting |
| Người dùng huỷ | `cancelled`, **giữ lại phần body dở dang** — review nửa chừng thường vẫn dùng được |
| `index.json` hỏng | dựng lại bằng cách quét các file `.md`; activate không bao giờ ném lỗi |
| Ghi store thất bại (hết đĩa) | review vẫn chạy xong, lỗi được báo, cây không chết |
| `globalStorageUri` chưa tồn tại | `mkdir -p` ở lần ghi đầu tiên |

## Testing

Repo mock toàn bộ module `vscode`, nên **không test tự động được việc view có thật sự
xuất hiện cạnh Terminal hay không** — phải kiểm thủ công bằng F5.

Test tự động:

| File | Nội dung |
|---|---|
| `tests/extension/review-store.test.ts` | round-trip index, thu hồi ở mốc 50 nhưng giữ bản `running`, dựng lại index hỏng, `repoId` ổn định qua symlink |
| `tests/extension/review-runner.test.ts` | fake spawn: stream ghi nối tiếp, thoát 0 → `done`, khác 0 → `failed`, cancel → `cancelled` và giữ body dở, `cancelAll` khi deactivate |
| `tests/extension/review-orphans.test.ts` | entry còn `running` lúc activate bị đổi thành `interrupted` |
| `tests/extension/review-tree-provider.test.ts` | entry → tree item, `contextValue` theo status, `description` là thời gian trôi khi chạy và thời gian tương đối khi xong |
| `tests/extension/extension-panel-session.test.ts` | `review.start` trả `id` ngay; trúng cache thì không spawn |

Checklist kiểm thủ công (F5):

1. Tab Code Review xuất hiện cạnh Git Graph và Terminal.
2. Chạy một review rồi click một commit trong graph: dòng review còn nguyên, vẫn đang chạy.
3. Ẩn Panel rồi hiện lại: dòng còn nguyên, đồng hồ vẫn chạy tiếp.
4. Bấm Cancel: dòng chuyển `cancelled`, kiểm `ps` thấy tiến trình đã chết.
5. Đóng VS Code giữa chừng: không còn tiến trình mồ côi; mở lại thấy dòng ghi `interrupted`.
6. Chạy lại đúng cặp nhánh chưa có commit mới: mở ra tức thì, không spawn.
7. Thêm một commit rồi chạy lại: sinh entry mới, cả hai cùng tồn tại.

## Roadmap

Phase 1-3 là của `2026-08-24-git-graph-bottom-panel-design.md`, giữ nguyên không đổi.

### Phase 4 — Review do host sở hữu

- **Deliverable:** `ReviewStore`, `ReviewRunner`, namespace `review.*`, giết tiến trình
  lúc `deactivate`, đánh dấu `interrupted` lúc activate, `onChunk` cho
  `AIReviewService`. Right panel hiện tại chuyển sang tạo job và đọc kết quả qua store.
- **Phụ thuộc:** không phụ thuộc Phase 1-3.
- **Nghiệm thu:** kết quả sống sót qua click commit và qua reload webview; đóng cửa sổ
  không để lại tiến trình mồ côi; `npm run check` xanh.
- **Ship độc lập:** có — riêng phase này đã diệt lỗi mất dữ liệu.

### Phase 5 — View review

- **Deliverable:** viewsContainer thứ hai, `TreeDataProvider`, lệnh cancel/rerun/delete,
  mở document.
- **Phụ thuộc:** Phase 4; và Phase 2 cho phần container ở bottom Panel.
- **Nghiệm thu:** checklist thủ công mục 1-6.
- **Ship độc lập:** có.

### Phase 6 — Graph panel chỉ còn là chỗ khởi động

- **Deliverable:** `AIReviewPanel` giữ Compare và danh sách file, bỏ phần render kết quả
  và biến `aiReviewResult`; đơn giản hoá nhánh `rightPanelMode === 'review'`.
- **Phụ thuộc:** Phase 5.
- **Nghiệm thu:** không còn đường nào dẫn tới trạng thái review mồ côi; lỗi ở
  `App.svelte:441` và `:1176` biến mất về mặt cấu trúc.
- **Ship độc lập:** có.

### Thứ tự thực hiện

Phase 4 **không phụ thuộc việc chuyển xuống bottom Panel** và là phase thật sự diệt lỗi
mất dữ liệu. Nếu muốn hết đau sớm nhất: **4 → 1 → 2 → 5 → 3 → 6**. Nếu muốn có bottom
Panel trước: **1 → 2 → 3 → 4 → 5 → 6**. Cả hai thứ tự đều hợp lệ vì mọi phase đều ship
độc lập được.
