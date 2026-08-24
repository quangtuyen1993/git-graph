# Tab Code Review thành workbench compare + review — Design

Ngày: 2026-08-24

## Mục tiêu

Định nghĩa lại tab Code Review (bottom Panel) từ **danh sách kết quả thụ động**
thành **chỗ làm việc compare + review hoàn chỉnh**: tự chọn 2 branch để compare,
xem danh sách file đổi, chạy review, review từng commit đơn lẻ, và compare khoảng
giữa 2 commit bất kỳ. Tab Git Graph trở thành entry point đẩy target sang. Mọi
đường compare/review dồn về một chỗ duy nhất.

Spec này kế thừa và sửa đổi `2026-08-24-review-panel-design.md`: kiến trúc
host-owned (`ReviewStore`, `ReviewRunner`, cache theo sha) **giữ nguyên**; phần bị
đảo là quyết định "không thêm launcher trên review view" và lựa chọn `TreeView`.

## Vấn đề hiện tại

1. **Khởi động review bị trói vào right panel của graph.** Muốn review phải mở
   graph, right-click branch, thao tác trong một panel dọc chật — trong khi tab
   Code Review (nơi kết quả nằm) không tự khởi động được gì.
2. **Chỉ review được branch với branch.** Không có đường review một commit đơn,
   không compare được khoảng giữa 2 commit bất kỳ.
3. **Hai UI cho một việc.** Right panel giữ Compare + launcher, tab Code Review
   giữ kết quả — người dùng phải nhảy qua lại và hai bên không chia sẻ state.

## Quyết định thiết kế

| Quyết định | Lựa chọn |
|---|---|
| Tab Code Review | Webview (Svelte app thứ 2), thay hẳn `TreeView` |
| Build | Vite input thứ 2 (`review.html` → `ReviewApp.svelte`), chung bridge/icons/theme |
| Right panel COMPARE của graph | Bỏ hẳn — right panel chỉ còn commit detail |
| Mục tiêu review | `kind: 'branch' \| 'commit' \| 'range'`, trường `base*` / `head*` |
| Entry point từ graph | Right-click branch, right-click commit (per-commit), select-2-commit (range) |
| Giao tiếp 2 webview | Host trung gian duy nhất; event broadcast tới mọi router đang attach |
| Compare target đang chọn | Host giữ theo repo, persist qua `globalState`; webview re-resolve thì hỏi lại |
| Cache | Không đổi luật: id ghép từ sha + provider + model |

**Vì sao webview chứ không phải TreeView + QuickPick.** Yêu cầu trung tâm là 2
branch picker thường trực + danh sách file đổi + danh sách review trong một mặt
phẳng — TreeView không đặt được dropdown, QuickPick là luồng 2 bước không nhìn
thấy trạng thái. Đổi lại phải tự viết list + nút inline (mất context menu native)
và chịu rủi ro webview bị dựng lại khi ẩn/hiện panel — mitigate bằng
`retainContextWhenHidden: true` và nguồn sự thật nằm hết ở host: webview dựng lại
là hỏi `review.getTarget` + `review.list` để về đúng trạng thái.

**Vì sao bỏ COMPARE khỏi right panel.** Hai UI cho cùng một việc là hai chỗ phải
giữ đồng bộ vĩnh viễn. Right panel dọc vốn chật cho danh sách file; bottom panel
ngang hợp hơn. Bỏ được ~578 dòng (`AIReviewPanel.svelte`) cộng state compare
trong `App.svelte`.

## Data model

### `ReviewEntry` tổng quát hoá

```ts
export type ReviewTargetKind = 'branch' | 'commit' | 'range';

export interface ReviewEntry {
  id: string;          // `${base7}..${head7}.${provider}.${model}` — GIỮ NGUYÊN cách ghép
  kind: ReviewTargetKind;
  baseRef: string;     // tên hiển thị: tên branch, hoặc sha7
  baseSha: string;
  headRef: string;
  headSha: string;
  provider: string;
  model: string;
  status: ReviewStatus;    // không đổi
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
```

- **Đổi tên `source*` → `base*`, `target*` → `head*`.** Spec trước cấm đổi tên
  "cho xuôi tai"; lần này ngữ nghĩa thật sự mở rộng — `sourceBranch` chứa sha7
  thì cái tên thành nói dối. Chiều diff **không đổi**: vẫn `base..head`, nhãn
  vẫn `base ← head`. Cấm đảo chiều vẫn nguyên hiệu lực.
- **Migration.** `ReviewStore.list()` gặp entry format cũ trong `index.json` thì
  map tại chỗ (`sourceBranch`→`baseRef`, `sourceSha`→`baseSha`,
  `targetBranch`→`headRef`, `targetSha`→`headSha`, thêm `kind: 'branch'`) và ghi
  lại một lần. Cache cũ không mất. Entry hỏng thì bỏ qua, không ném.

### Ngữ nghĩa từng kind

| Kind | base | head | Ghi chú |
|---|---|---|---|
| `branch` | branch người dùng chọn | branch người dùng chọn | như hiện tại |
| `commit` | **host tự tính** `sha^` | sha commit | root commit → base = empty-tree hash (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`); merge commit → base = `sha^1` (first parent), nhãn row ghi `(merge)` |
| `range` | sha chọn trước | sha chọn sau | không kiểm tra ancestor — `git diff A..B` luôn có nghĩa; đảo được bằng nút ⇄ |

Diff rỗng (mọi kind) → từ chối tạo entry, báo lỗi tại header — như hành vi hiện tại.

### Compare target đang chọn

Cặp `{kind, baseRef, headRef}` đang hiện trên picker là state **host giữ theo
repoId** (`ReviewTargetState`), memory-first và **persist qua `globalState`**
(key `review.target.<repoId>`): reload cửa sổ mở lại đúng cặp đang so. Picker
đổi giá trị thì webview ghi write-behind qua `review.saveTarget` (không
resolve/focus/broadcast). Repo chưa từng chọn gì thì picker mặc định head =
branch hiện tại, base = `main`/`master` nếu tồn tại (heuristic, không đọc
origin/HEAD). Đổi repo active thì target theo repo nào hiện repo đó, không lẫn.

## Kiến trúc

### Contribution points (`package.json`)

```jsonc
"views": {
  "gitGraphProReview": [{
    "type": "webview",
    "id": "gitGraphPro.reviews",
    "name": "Reviews",
    "webviewOptions": { "retainContextWhenHidden": true }
  }]
}
```

Xoá 3 command tree (`gitGraphPro.review.cancel/rerun/delete`) khỏi `commands` +
`menus.view/item/context` — chúng thành nút inline trong webview, đi qua router
`review.*` sẵn có. Xoá `ReviewTreeProvider` và phần đăng ký tree trong
`review-view-registration.ts`.

### Build

`vite.config.ts` thêm input thứ 2:

```ts
input: {
  main:   resolve(__dirname, 'src/webview/index.html'),
  review: resolve(__dirname, 'src/webview/review.html'),
}
```

`ReviewApp.svelte` dùng chung `lib/message-bridge`, `Icon`, theme token với graph
app. Không dùng chung bundle: tab review không phải tải virtual scroll, canvas…

### Layout `ReviewApp.svelte`

```
┌─────────────────────────────────────────────────────────────┐
│ [base ▾]  ←  [head ▾]  [⇄]   [provider ▾][model] [Review]   │  header
├──────────────────────────┬──────────────────────────────────┤
│ CHANGED FILES (23) +512−88│ REVIEWS                          │
│  src/a.ts        +12 −3   │ ⟳ main ← feat/x   2m14s  [✕]     │
│  src/b.ts        +40 −0   │ ✓ abc1234 "fix: …" 8m ago [↻][🗑] │
│  (click → mở diff editor) │ ✓ abc12..def45     1h ago [↻][🗑] │
└──────────────────────────┴──────────────────────────────────┘
```

- **Picker**: 2 dropdown liệt kê branch local + remote (tái dùng `git.branches`),
  nút ⇄ đảo base/head. Chọn đủ 2 bên là **compare tự chạy** → danh sách file đổi
  + tổng ±. Click file → `ui.compareDiff` mở diff editor (đường đã có). Compare
  đang chạy mà đổi picker → request cũ bị bỏ theo `latest-request` (lib sẵn có).
- **Chip commit/range**: target đến từ graph với `kind: 'commit' | 'range'` thì
  header thay dropdown bằng chip `abc1234 "subject"` / `abc1234..def4567` kèm nút
  ✕ quay về chế độ branch. Chip không sửa tay — muốn cặp khác thì chọn lại từ
  graph; không xây ô nhập sha tự do.
- **Danh sách review**: rows từ `review.list`, nhãn theo kind (`main ← feat/x`,
  `abc1234 "subject"`, `abc12..def45`), icon status như TreeView cũ, thời gian
  trôi/tương đối tick 1 giây khi có run đang chạy, nút inline theo status
  (running → Cancel; còn lại → Re-run, Delete). Click row → `review.open`. Row
  của lần start mới nhất được highlight. Provider/model selector giữ hành vi lưu
  setting như `AIReviewPanel` cũ.

### Entry points từ tab Git Graph

Cả 3 đường đi qua **một method mới `review.setTarget {kind, baseRef, headRef}`**:
host resolve ref, lưu target vào `ReviewTargetState`, gọi
`gitGraphPro.reviews.focus`, phát event `review.target` → tab Code Review điền
picker/chip và tự compare. **Không đường nào tự chạy review** — chạy là nút
Review, người dùng bấm.

1. **Right-click branch** → `Compare with current branch` (action `compareBranch`
   hiện có, đổi đích): base = branch vừa click, head = branch hiện tại.
2. **Right-click commit** → `Review this commit`: `kind: 'commit'`, headRef = sha.
3. **Right-click commit** → `Select for compare`, rồi right-click commit khác →
   `Compare with selected abc1234`: `kind: 'range'`. Commit đang selected được
   đánh dấu nhẹ trên graph; chọn lại commit khác thì thay thế; không huỷ bằng
   Esc — chỉ bị thay khi chọn lại. Không làm Ctrl-click multi-select — thêm sau
   được nếu thấy cần.

`review.setTarget` với ref không resolve được (branch vừa xoá, sha bị gc) → tab
vẫn focus, lỗi hiện tại header có tên ref, picker giữ giá trị cũ.

### Luồng message giữa 2 webview

Hai webview không nói chuyện trực tiếp — **host là trung gian duy nhất**.
`MessageRouter` vốn tạo theo từng webview session; hiện `review.changed` chỉ bắn
vào `activeRouter` (graph). Đổi thành: host giữ **danh sách router đang attach**;
event (`review.changed`, `review.target`) broadcast cho cả danh sách; router
dispose thì rời danh sách. Tab review lúc `resolveWebviewView` gọi
`review.getTarget` + `review.list` để dựng lại state — ẩn/hiện panel hay reload
đều về đúng trạng thái. Race "graph gửi setTarget khi tab review chưa từng mở"
không tồn tại: target nằm ở host, webview dựng xong là đọc được.

### `review.start` tổng quát hoá

Params: `{kind, baseRef, headRef, provider, model}`. Handler:

- `kind: 'commit'` → tự tính baseRef = `${headRef}^` (root → empty tree, merge →
  `^1`) trước khi rev-parse.
- Rev-parse cả 2 → `baseSha`, `headSha`; id, cache hit, dedup running — logic
  hiện tại giữ nguyên.
- `buildReviewPayload` nhận thêm ngữ cảnh kind (commit đơn thì `commits` là chính
  subject của nó, range thì log `base..head` như branch).

### Dọn dẹp phía graph

- Xoá `AIReviewPanel.svelte` (578 dòng).
- `App.svelte`: bỏ `rightPanelMode === 'review'`, `compareBranches()`,
  `handleAIReview()`, `handleCompareOpenDiff()`, state compare/aiReview — right
  panel chỉ còn commit detail, title luôn `COMMIT`.
- `ai.compare` đổi thành `review.compare` (tab review dùng); namespace `ai.*` còn
  lại chỉ để liệt kê provider.

## Xử lý lỗi

Nguyên tắc kế thừa spec trước: mọi kiểu hỏng kết thúc thành một dòng nhìn thấy
được, không bao giờ mất im lặng.

| Tình huống | Kết quả |
|---|---|
| `setTarget` ref không resolve được | Lỗi hiện tại graph (nơi người dùng click) kèm tên ref; tab review không bị focus, picker giữ giá trị cũ |
| Review commit trên root commit | base = empty-tree, diff là toàn bộ commit — chạy bình thường |
| Review commit trên merge commit | base = first parent; nhãn row ghi `(merge)` |
| Diff rỗng | Từ chối tạo entry, báo tại header |
| Đổi picker khi compare đang chạy | Request cũ bỏ theo `latest-request`, không render đè |
| `index.json` chứa entry format cũ | Migrate tại chỗ khi `list()`, ghi lại một lần; entry hỏng bỏ qua |
| Tab review chưa từng mở mà graph `setTarget` | `reviews.focus` resolve webview; target ở host nên không có race |
| Webview bị dựng lại (ẩn/hiện, reload) | `getTarget` + `list` dựng lại state; run đang chạy không ảnh hưởng (host sở hữu) |

## Testing

Test tự động (vitest, mock `vscode` như hiện tại):

| File | Nội dung |
|---|---|
| `review-store.test.ts` (mở rộng) | migration entry cũ → mới; round-trip `kind: commit/range` |
| `review-method-handler.test.ts` (mở rộng) | `review.start` 3 kind; commit → base `sha^`; root → empty tree; merge → first parent; `setTarget`/`getTarget` round-trip; ref hỏng → lỗi có tên ref |
| `review-target-state.test.ts` (mới) | state theo repo; đổi repo không lẫn target |
| `router-broadcast.test.ts` (mới) | event đến mọi router đang attach; dispose thì rời danh sách |
| Xoá | `review-tree-provider.test.ts`; phần tree của `review-view-registration` test |

UI webview không có hạ tầng test component — checklist thủ công (F5):

1. Mở tab Code Review: picker mặc định head = branch hiện tại, base = branch mặc định.
2. Chọn 2 branch → file list hiện; click file mở diff; bấm Review → row running.
3. Right-click branch trong graph → tab focus, picker điền đúng, compare tự chạy.
4. Right-click commit → Review this commit → chip commit, Review chạy đúng diff một commit.
5. Select for compare + Compare with selected → chip range, diff đúng khoảng.
6. Ẩn Panel rồi hiện lại: picker/chip/file list/danh sách review còn nguyên.
7. Cancel một run đang chạy từ nút inline: tiến trình chết (`ps` kiểm), row `cancelled`.
8. Reload cửa sổ: danh sách review còn (store), picker về mặc định (đúng thiết kế).

## Roadmap

### Phase 1 — Host: model + target state

- **Deliverable:** `ReviewEntry` mới + migration trong `ReviewStore`;
  `review.start` nhận `{kind, baseRef, headRef}` và tự tính base cho commit;
  `review.setTarget` / `review.getTarget` + `ReviewTargetState` theo repo; router
  broadcast list. TreeView cũ **vẫn chạy** qua adapter nhãn `base ← head`.
- **Phụ thuộc:** không.
- **Nghiệm thu:** toàn bộ test xanh; review branch từ right panel cũ vẫn hoạt
  động; cache format cũ đọc được sau migration.
- **Ship độc lập:** có — thuần backend, không đổi UI.

### Phase 2 — Tab Code Review webview

- **Deliverable:** vite input `review.html` + `ReviewApp.svelte` (picker, compare,
  danh sách review, nút inline, chip commit/range); `package.json` đổi view sang
  webview + xoá 3 command tree; xoá `ReviewTreeProvider` và phần tree của
  `review-view-registration`.
- **Phụ thuộc:** Phase 1.
- **Ghi chú:** ReviewApp gọi `ai.compare` sẵn có trong phase này; rename sang
  `review.compare` là việc của Phase 3.
- **Nghiệm thu:** checklist thủ công mục 1-2, 6-8; cancel giết được tiến trình.
- **Ship độc lập:** có — tab mới thay tab cũ; right panel graph vẫn là launcher
  song song cho tới Phase 3.

### Phase 3 — Entry points từ graph + dọn right panel

- **Deliverable:** 3 menu action (`Compare with current branch`, `Review this
  commit`, `Select for compare` / `Compare with selected` + đánh dấu commit
  selected trên graph); xoá `AIReviewPanel.svelte` + mode `review` của right
  panel; `ai.compare` → `review.compare`.
- **Phụ thuộc:** Phase 2.
- **Nghiệm thu:** checklist thủ công mục 3-5; graph không còn đường review nào
  ngoài `setTarget`; `npm run check` xanh.
- **Ship độc lập:** có.

### Thứ tự thực hiện

`1 → 2 → 3`, mỗi phase ship độc lập được. Không có đường tắt: Phase 2 cần model
mới của Phase 1, Phase 3 chỉ được xoá right panel khi tab mới (Phase 2) đã nhận
được target.
