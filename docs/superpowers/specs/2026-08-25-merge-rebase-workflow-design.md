# Merge và rebase trọn vẹn, kể cả khi conflict — Design

Ngày: 2026-08-25

## Mục tiêu

Làm cho merge và rebase dùng được như ở một git GUI thật: đủ tuỳ chọn (no-ff,
ff-only, squash, `--onto`, autostash), rebase được lên **remote branch** và lên
một commit bất kỳ, và — quan trọng nhất — khi đụng conflict thì panel **nói ra
điều đó và đưa đường đi tiếp**, thay vì chớp một dòng lỗi rồi bỏ mặc repo ở trạng
thái dở dang.

Giải quyết conflict mượn merge editor 3-way có sẵn của VS Code. Interactive rebase
(kéo thả pick/squash/drop) **không** thuộc spec này; nó là spec riêng dựng lên hạ
tầng ở đây.

## Vấn đề hiện tại

Backend có `merge(branch, {noFF, message})` (`git.service.ts:265`) và
`rebase(onto)` (`:272`) — cả hai đều là lớp vỏ mỏng nhất có thể. Bên trên chúng
là ba lỗ thủng:

**1. Rebase lên remote branch không có lối vào.** Menu remote branch
(`App.svelte:704`) chỉ có Checkout / Merge / Delete. Menu local branch (`:737`)
có `Rebase current onto this`, nhưng remote thì không. Đây là thao tác hằng ngày
(`rebase lên origin/main`) và nó đơn giản là vắng mặt.

**2. Conflict làm UI câm.** `merge`/`rebase` gặp conflict thì git thoát khác 0,
`GitCLI` ném `GitCLIError`, và `App.svelte:905` gán vào `error` rồi
`setTimeout(() => error = '', 5000)`. Sau 5 giây màn hình trông như chưa có
chuyện gì, trong khi repo đang ở giữa một cuộc rebase. Không có banner, không có
Continue, không có Abort, không có danh sách file conflict.

**3. Không ai biết repo đang dở dang.** `GitStatus` (`git.types.ts:41`) có
`conflicted[]` nhưng không có khái niệm "đang merge" hay "đang rebase bước 3/7".
Panel không phân biệt được conflict của merge với conflict của rebase, nên không
thể đưa đúng nút.

Kèm theo là một lỗ thủng nhỏ hơn nhưng chặn mọi thứ ở trên: `GitErrorCode` là
enum **số** (`git.types.ts:83`), còn `message-router.ts:57` chỉ chuyển tiếp
trường `kind` khi `code` là **string**. Nghĩa là hôm nay webview không thể phân
biệt "conflict" với "sai mật khẩu" — mọi lỗi git đều tới nơi dưới dạng một chuỗi
tiếng người.

## Quyết định thiết kế

| Quyết định | Lựa chọn |
|---|---|
| Nguồn sự thật của trạng thái dở dang | Đọc file trong `.git`, không parse `git status` |
| Cách webview biết trạng thái đổi | Mở rộng `FileSystemWatcher` sẵn có, bắn `git.operationChanged` |
| Conflict là gì | Một **kết quả hợp lệ**, không phải exception |
| Giải quyết conflict | Merge editor của VS Code, không tự viết 3-way |
| Working tree bẩn | Hỏi một lần, mặc định `--autostash` của git |
| Tuỳ chọn merge | Một enum `mode`, không phải các boolean rời |
| Continue/Skip/Abort | Ba lệnh dispatch theo `kind`, thay `abortMerge`/`abortRebase` |
| Interactive rebase | Ngoài phạm vi, spec riêng |

**Vì sao đọc `.git` chứ không dựa vào lỗi trả về.** Lỗi chỉ tồn tại trong khoảnh
khắc lệnh chạy. Reload webview là mất; đóng VS Code mở lại là mất; và conflict
mày tự tạo ra bằng `git rebase` trong terminal thì panel không bao giờ thấy.
Filesystem thì luôn đúng, cho cả ba trường hợp. Đây là lý do duy nhất đáng để
làm nặng hơn phương án bắt-lỗi.

**Vì sao không parse `git status`.** `git status` in ra tiếng người và bị dịch
theo locale. Repo này đã ăn một lần đau vì chuyện đó — xem comment ở
`git.service.ts:238`, chỗ `deleteBranch` phải hỏi lại git bằng câu hỏi khác thay
vì so khớp stderr. Đọc `.git/rebase-merge/msgnum` không có nghĩa nào khác ngoài
một con số.

**Vì sao conflict không phải exception.** Ném exception buộc mọi call-site coi
conflict là hỏng, và đường xử lý mặc định của "hỏng" là hiện lỗi rồi thôi — đúng
cái đang xảy ra hôm nay. Trả về `{ status: 'conflict', state }` buộc call-site
phải nhìn vào nó. Exception để dành cho thứ thật sự sai: mất mạng, ref không tồn
tại, tree bẩn mà không cho autostash.

**Vì sao mượn merge editor VS Code.** Tự viết 3-way editor trong webview nghĩa là
tự viết parser hunk, tự làm undo, tự làm syntax highlight, và bảo trì chúng mãi
mãi. Merge editor của VS Code đã có, người dùng đã quen, và nó tốt hơn thứ ta có
thể viết trong phạm vi này. Cái ta thêm vào là thứ VS Code không có: bối cảnh
graph quanh cuộc merge.

**Vì sao `mode` là enum.** `--no-ff` và `--ff-only` loại trừ nhau. Để chúng là
hai boolean rời thì một call-site đặt cả hai sẽ compile được và chết lúc runtime.
Enum một-chọn-một khiến TypeScript chặn từ đầu.

## Kiến trúc

### `services/operation-state.ts` (mới)

```ts
export type OperationKind =
  | 'merge' | 'rebase' | 'rebase-interactive' | 'cherry-pick' | 'revert' | null;

export interface OperationState {
  kind: OperationKind;
  /** Ref hoặc subject đang được áp vào: "origin/main", hoặc subject commit đang rebase */
  incoming: string | null;
  /** Nhánh/commit đang rebase lên. Chỉ rebase mới có. */
  onto: string | null;
  /** Nhánh gốc đang được rebase, từ rebase-merge/head-name */
  headName: string | null;
  step: number | null;
  total: number | null;
  conflicted: string[];
  /** Hết file conflict → `--continue` chạy được */
  canContinue: boolean;
}
```

Nhận diện theo đúng thứ tự git ưu tiên:

| Kind | Dấu hiệu trong thư mục `.git` |
|---|---|
| `rebase-interactive` | `rebase-merge/interactive` tồn tại |
| `rebase` | `rebase-merge/` hoặc `rebase-apply/` |
| `merge` | `MERGE_HEAD` |
| `cherry-pick` | `CHERRY_PICK_HEAD` |
| `revert` | `REVERT_HEAD` |

Các trường phụ: `onto` ← `rebase-merge/onto`, `headName` ←
`rebase-merge/head-name`, `step` ← `rebase-merge/msgnum`, `total` ←
`rebase-merge/end`, `incoming` ← `rebase-merge/message` dòng đầu hoặc
`git name-rev --name-only MERGE_HEAD`. Với `rebase-apply/` (rebase kiểu am) dùng
`next`/`last` thay cho `msgnum`/`end`.

Thư mục `.git` lấy qua `GitService.gitDirectory()` (`git.service.ts:172`) — nó
dùng `rev-parse --absolute-git-dir`, nên đúng cả với worktree và submodule, nơi
`.git` là file chứ không phải thư mục.

`conflicted[]` tái dùng `parseStatus()` sẵn có, không parse lại.

### Typed error đi được tới webview

Thêm `kind: string` vào `GitCLIError`, song song với `code: GitErrorCode` số. Enum
cũ giữ nguyên để không đụng call-site nào. `classifyError` (`git-cli.ts:123`) trả
thêm chuỗi tương ứng, và `message-router.ts:57` chuyển tiếp nó.

### `GitService` — bề mặt lệnh

```ts
type MergeMode = 'default' | 'noFF' | 'ffOnly' | 'squash';

interface MergeOptions {
  mode?: MergeMode;
  noCommit?: boolean;
  message?: string;
  autostash?: boolean;
}

interface RebaseOptions {
  upstream: string;
  onto?: string;
  branch?: string;
  autostash?: boolean;
}

type OperationOutcome =
  | { status: 'ok' }
  | { status: 'conflict'; state: OperationState };

merge(ref: string, options?: MergeOptions): Promise<OperationOutcome>
rebase(options: RebaseOptions): Promise<OperationOutcome>

continueOperation(): Promise<OperationOutcome>
skipOperation(): Promise<OperationOutcome>
abortOperation(): Promise<void>
```

`rebase(onto: string)` cũ bị thay hẳn. Chỉ có hai call-site
(`git-method-handler.ts:52`, `App.svelte:1218`); giữ hai đường song song tốn hơn
là sửa.

`continueOperation`/`skipOperation`/`abortOperation` hỏi `operationState()` trước
rồi mới chọn lệnh, nên không thể gọi `merge --abort` khi đang rebase.
`abortMerge()`/`abortRebase()` cũ bị gỡ.

**Bẫy `--continue`.** `merge --continue`, `rebase --continue`,
`cherry-pick --continue`, `revert --continue` đều mở `$GIT_EDITOR` để sửa commit
message. `git-cli.ts:53` spawn với stdio pipe và không set `GIT_EDITOR`, nên git
sẽ treo cho tới khi timeout 30s rồi ăn SIGTERM — bỏ lại repo ở trạng thái tệ hơn
lúc đầu. Mọi lệnh `--continue` phải chạy với `GIT_EDITOR=true` và
`GIT_SEQUENCE_EDITOR=true`. `GitCLIOptions.env` đã có sẵn đường truyền.

Timeout của merge/rebase/continue dùng 120s (`REBASE_TIMEOUT_MS` đang có), không
phải 30s mặc định.

**Autostash** dùng cờ `--autostash` gốc của git (≥ 2.14) cho cả merge lẫn rebase,
không tự stash push/pop. Git tự pop lại kể cả khi abort giữa chừng; tự làm chỉ là
chép lại một cách tệ hơn.

### Host methods

| Method | Ghi chú |
|---|---|
| `git.operationState` | đọc, không mutation |
| `git.merge` | params đổi: `{ ref, options }` |
| `git.rebase` | params đổi: `{ upstream, onto?, branch?, autostash? }` |
| `git.continueOperation` | mutation |
| `git.skipOperation` | mutation |
| `git.abortOperation` | mutation; thay `git.abortMerge`/`git.abortRebase` |
| `git.resolveFile` | `{ path, resolution: 'ours' \| 'theirs' \| 'staged' }` |
| `ui.openMergeEditor` | `{ path }` |

Bốn method mutation mới phải vào `MUTATION_REQUEST_METHODS`
(`message-bridge.ts:29`) để webview không tự áp deadline 30s lên chúng.

`ui.openMergeEditor` dựng URI từ `getRepoPath()` rồi gọi
`executeCommand('git.openMergeEditor', uri)`. Lệnh đó thuộc extension `vscode.git`
— có thể bị tắt hoặc vắng, nên bọc try/catch và rơi về `vscode.open`. Một
extension khác vắng mặt không được phép làm hỏng tính năng này.

### Watcher

Pattern ở `extension.ts:219` mở rộng từ `{HEAD,refs/**,index}` thành:

```
{HEAD,refs/**,index,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}
```

Bắn thêm `git.operationChanged` cạnh `git.refsChanged`, đi qua cùng đường debounce
500ms và cùng cổng `isVisible()` đang có.

### UI

**`components/actions/OperationBanner.svelte`** (mới), đặt giữa
`<header class="toolbar">` (`App.svelte:1391`) và `error-banner` (`:1463`):

```
⚠ Rebasing main onto origin/main — 3/7 · 2 file conflict
   [Xem conflict]  [Continue]  [Skip]  [Abort]
```

- Banner **không tự tắt**. Trạng thái dở dang không tự biến mất, và một banner tự
  biến mất khỏi thứ chưa xong là nói dối.
- `Continue` disabled khi `!canContinue`, tooltip liệt kê file còn conflict.
- `Skip` chỉ hiện với rebase / cherry-pick / revert. Merge không có `--skip`.
- `Abort` là `danger`, qua `ui.confirm`.
- `3/7` tự ẩn khi `step`/`total` là null (merge, cherry-pick).

**Danh sách file conflict**: một section trong panel chi tiết, tái dùng
`FileTreeList.svelte`. Mỗi dòng:

| Hành động | Thực hiện |
|---|---|
| Click | `ui.openMergeEditor` |
| Take Ours | `git.resolveFile` → `checkout --ours` + `add` |
| Take Theirs | `git.resolveFile` → `checkout --theirs` + `add` |
| Mark resolved | `git.resolveFile` → `add` |

**Cập nhật**: banner nghe `git.operationChanged` rồi gọi lại `git.operationState`.
Không giữ state cục bộ trong Svelte. Resolve trong merge editor rồi save → watcher
bắn event → `canContinue` tự bật. Đây là chỗ trả công cho quyết định đọc `.git`.

**Dirty tree**: trước merge/rebase gọi `git.status`; nếu bẩn thì `ui.confirm`
"Có thay đổi chưa commit. Stash tạm rồi tiếp tục?" → Có thì truyền
`autostash: true`, Không thì huỷ.

**Quan hệ với `mutationGate`.** Gate chặn hai mutation chạy chồng
(`mutation-gate.ts:15`). Trạng thái dở dang thì kéo dài hàng phút — giữ gate suốt
thời gian đó sẽ khoá cả checkout lẫn xem diff. Nên gate chỉ ôm **một lệnh git**,
còn "đang conflict" là state riêng của banner. Bù lại, khi `kind !== null` thì mọi
mục merge / rebase / cherry-pick / revert trong context menu bị disable kèm tooltip
"Đang có `<kind>` dở dang" — vì git sẽ từ chối chúng.

## Entry points

**Menu remote branch** (`App.svelte:704`) — lỗ thủng chính:

```
Checkout
Merge  ▸  Merge vào <current>
          Merge (no fast-forward)
          Merge (fast-forward only)
          Merge (squash)
Rebase ▸  Rebase <current> lên origin/main
──────
Delete remote branch
```

**Menu local branch** (`:737`): như trên, cộng `Rebase --onto…` mở
`ui.pickBranch` (`extension.ts:357`) để chọn newbase.

**Menu current branch** (`:712`): thêm `Merge nhánh vào đây…` và
`Rebase nhánh này lên…`, cả hai qua `ui.pickBranch`.

**Menu commit** (`:668`): thêm `Rebase nhánh hiện tại lên commit này`, disabled khi
commit nằm trên nhánh hiện tại — dùng `git.isOnCurrentBranch` đã có.

`ContextMenu.svelte` đã hỗ trợ `children` (xem `App.svelte:715`), nên submenu không
cần component mới.

## Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Conflict | `{ status: 'conflict', state }` → banner. Không phải lỗi. |
| `ff-only` mà lịch sử phân kỳ | Throw. Không có gì để hiện banner; đây là từ chối, không phải dở dang. |
| Tree bẩn, không autostash | Throw `DIRTY_WORKING_TREE`; UI đã hỏi trước nên hiếm khi tới đây. |
| `--continue` khi vẫn còn conflict | Chặn ở UI qua `canContinue`; nếu vẫn lọt thì git từ chối và ta hiện stderr. |
| `git.openMergeEditor` vắng | Fallback `vscode.open`. |
| Autostash pop conflict sau khi rebase xong | `kind` về null nhưng `conflicted[]` khác rỗng — banner chuyển sang thông báo "stash pop bị conflict", không có Continue/Skip. |
| Thư mục `.git` đọc không được | `operationState()` trả `kind: null` thay vì ném; panel mất banner còn hơn panel chết. |

## Testing

| Tầng | Test |
|---|---|
| `operation-state.ts` | Integration `TempGitRepo`: dựng conflict thật cho merge / rebase / cherry-pick / revert; khẳng định `kind`, `step`/`total`, `conflicted[]`, `canContinue`, `onto`, `headName` |
| Vòng đời | rebase conflict → resolve → `continueOperation` → `kind` về null; và nhánh abort trả repo về đúng HEAD cũ |
| Bẫy editor | `--continue` chạy với `GIT_EDITOR=true` và trả về dưới timeout — không treo |
| Options | Mỗi `MergeMode` dựng argv đúng; `ffOnly` gặp phân kỳ thì throw chứ không trả conflict; `rebase --onto` dựng đủ ba tham số |
| Typed error | `GitCLIError.kind` là string và tới được webview qua router |
| `rebase-apply` | Rebase kiểu am đọc `next`/`last` đúng |
| Webview | `OperationBanner`: nút hiện/ẩn theo `kind`, `Continue` disabled khi còn conflict, phản ứng với `git.operationChanged` |
| Menu | Rebase có mặt trong menu remote branch; mọi mục merge/rebase disabled khi `kind !== null` |

**Sửa helper**: `TempGitRepo.execGit` (`tests/helpers/temp-git-repo.ts:22`) dùng
`execFile` nên ném khi exit ≠ 0 — mà dựng conflict bắt buộc phải chạy một lệnh git
thất bại. Thêm `execGitAllowFailure()` trả `{ stdout, stderr, code }`.

## Roadmap

### Phase 1 — Đọc được trạng thái dở dang

- **Deliverable:** `services/operation-state.ts`; `GitCLIError.kind` dạng string
  và router chuyển tiếp nó; host method `git.operationState`; watcher mở rộng
  pattern và bắn `git.operationChanged`. **Chưa có UI nào.**
- **Phụ thuộc:** không.
- **Nghiệm thu:** integration test dựng conflict cho cả bốn loại thao tác và đọc
  ra đúng `kind`/`step`/`total`/`conflicted`; `npm run check` xanh.
- **Ship độc lập:** có — không đổi gì nhìn thấy được, nhưng là nền của mọi phase
  sau và tự nó kiểm chứng được.

### Phase 2 — Bề mặt lệnh merge/rebase

- **Deliverable:** `merge(ref, options)` với `MergeMode`, `rebase(RebaseOptions)`
  có `--onto` và `--autostash`, `continueOperation`/`skipOperation`/
  `abortOperation` với `GIT_EDITOR=true`; các host method tương ứng; gỡ
  `abortMerge`/`abortRebase`; `execGitAllowFailure` trong test helper.
- **Phụ thuộc:** Phase 1 (dispatch theo `kind`, trả `OperationState` trong outcome).
- **Nghiệm thu:** test vòng đời conflict → continue → sạch, và conflict → abort →
  về HEAD cũ, chạy qua service chứ không qua UI.
- **Ship độc lập:** có — call-site cũ được cập nhật, hành vi nhìn thấy chưa đổi.

### Phase 3 — Banner và giải quyết conflict

- **Deliverable:** `OperationBanner.svelte` với Continue/Skip/Abort; danh sách file
  conflict với Ours/Theirs/Mark resolved; `git.resolveFile`; `ui.openMergeEditor`
  kèm fallback; disable menu khi `kind !== null`.
- **Phụ thuộc:** Phase 1 và 2.
- **Nghiệm thu:** thủ công — gây conflict, resolve trong merge editor VS Code,
  banner tự bật `Continue`, bấm là xong. Gây conflict từ terminal, panel vẫn hiện
  banner.
- **Ship độc lập:** có — đây là phase mang lại giá trị chính.

### Phase 4 — Entry points

- **Deliverable:** submenu Merge/Rebase cho remote branch, local branch, current
  branch; `Rebase --onto…` qua `ui.pickBranch`; `Rebase lên commit này` trong menu
  commit; hỏi autostash khi tree bẩn.
- **Phụ thuộc:** Phase 2 (options), Phase 3 (disable theo state).
- **Nghiệm thu:** test menu; thủ công rebase lên `origin/main` từ sidebar.
- **Ship độc lập:** có.

### Phase 5 (spec riêng) — Interactive rebase

Không thuộc spec này. `utils/rebase-todo.ts` và `runHistoryRewrite`
(`git.service.ts:598`) đã có sẵn phần rewrite; phase này chỉ cần panel kéo thả và
sẽ dùng lại `OperationState.kind === 'rebase-interactive'` của Phase 1.
