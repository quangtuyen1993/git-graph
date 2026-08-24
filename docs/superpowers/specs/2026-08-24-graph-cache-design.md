# Cache màn hình đầu để mở panel là thấy ngay — Design

Ngày: 2026-08-24

## Mục tiêu

Mở Git Graph lên là **vẽ ngay**, không đợi `git log` chạy xong. Panel vẽ lại màn
hình đầu tiên từ cache, đồng thời chạy git ở nền, rồi thay bằng dữ liệu mới. Đây
là cách các git GUI khác làm, và nó đổi hẳn cảm giác dùng ở repo lớn.

## Vấn đề hiện tại

Không có gì sống sót qua một session. `GraphService` giữ layout trong bộ nhớ và
huỷ nó mỗi khi refs đổi, nên **mỗi lần mở mới là dựng lại từ đầu**. Chuỗi mount
chạy tuần tự và dồn hết vào đường tới hạn:

```
ping.hello
repo.list          ← chạy `git submodule status` cho MỖI repo trong workspace
refreshGraph()
  ├ 7 lời gọi git song song (branches, tags, stashes, worktrees, submodules, status)
  └ graph.build    ← loadAllCommits phân trang `git log`, mỗi lần 500 commit, cho TOÀN BỘ commit
graph.getWindow
ai.providers       ← spawn `which` cho claude, codex, kiro-cli, openai
```

`graph.build` là chỗ tăng theo kích thước repo: repo 50k commit tương đương ~100
vòng `git log` tuần tự trước khi có gì hiện ra. `ai.providers` tốn 4 lần spawn
tiến trình; nó không chặn thứ gì nhìn thấy được nhưng vẫn nằm trên cùng chuỗi
`await`.

## Quyết định thiết kế

| Quyết định | Lựa chọn |
|---|---|
| Chiến lược | Stale-while-revalidate: vẽ cache ngay, làm mới ở nền |
| Phạm vi cache | Chỉ màn hình đầu (~60 dòng) + metadata sidebar |
| Nơi lưu | File theo repo dưới `globalStorageUri` |
| Ai lắp snapshot | Webview lắp, host lưu |
| Khoá repo | Host đóng dấu, không lấy từ payload |
| Khoá hợp lệ | head sha + `totalRows`, so ở webview |
| Kiểu window | Lưu nguyên `GraphWindow`, không cắt bớt |

**Vì sao chỉ màn hình đầu.** Cache toàn bộ layout sẽ khiến cuộn cũng tức thì,
nhưng repo lớn ngốn vài MB trên đĩa, ghi chậm hơn, và phải nghĩ thêm về dọn dẹp.
Màn hình đầu chỉ ~30KB dù repo có 50k commit, và nó đủ cho đúng thứ ta cần:
"mở lên là thấy".

**Vì sao webview lắp snapshot.** Host sở hữu chỗ lưu, nhưng snapshot trải qua
`graph.build` và sáu lời gọi `git.*` nằm ở các handler khác nhau. Để host tự lắp
thì host phải chạy lại đúng những lệnh git mà webview vừa chạy. Lắp ở webview tốn
một payload ~30KB đi qua bridge; lắp ở host tốn một bộ lệnh git trùng lặp mỗi lần
refresh.

**Vì sao repo id do host đóng dấu.** Nếu lấy từ payload, một webview vừa đổi repo
giữa chừng có thể lưu graph của repo X dưới khoá của repo Y, và lần mở sau sẽ vẽ
một graph sai một cách rất tự tin. Đây là chỗ duy nhất mà tin vào bên gửi thực sự
gây hại.

## Kiến trúc

### `services/graph-cache.ts`

```
globalStorageUri/graph-cache/<repoId>.json
```

`repoId` dùng lại `repoIdFor()` của `review-key.ts` — sha256 của realpath, cắt 12
ký tự, an toàn cho tên file và ổn định qua symlink.

```ts
export interface GraphSnapshot {
  headSha: string;        // host đóng dấu
  totalRows: number;
  maxLane: number;
  /*
   * Lưu nguyên GraphWindow chứ không cắt bớt: webview khai báo window có đủ
   * nodes, edges, startRow, endRow, totalRows, maxLane (App.svelte:60-67), nên
   * một shape rút gọn sẽ lệch kiểu ngay tại chỗ gán.
   */
  window: GraphWindow;
  branches: Branch[];
  tags: Tag[];
  stashes: StashEntry[];
  worktrees: WorktreeEntry[];
  hasWorkingChanges: boolean;
  savedAt: string;        // ISO, dùng cho việc giới hạn số file
}

export class GraphCache {
  constructor(rootDir: string);
  read(repoId: string): Promise<GraphSnapshot | null>;
  write(repoId: string, snapshot: GraphSnapshot): Promise<void>;
  prune(maxEntries: number): Promise<void>;
}
```

**Ghi phải nguyên tử**: ghi ra file tạm rồi `rename()`. Đây đúng là lớp lỗi mà
`ReviewStore` đã dính (C3 trong đợt review trước): `writeFile` cắt file trước khi
ghi, nên một người đọc rơi vào đúng khoảng đó sẽ thấy JSON dở dang.

**Đọc không bao giờ ném lỗi**: file thiếu, JSON hỏng, hay shape sai đều trả
`null`. Cache hỏng phải thoái hoá thành "không có cache", không bao giờ thành
lỗi activate.

**Giới hạn 20 file**, xoá theo `savedAt` cũ nhất. Repo cũ để lại ~30KB mỗi cái;
không giới hạn thì thư mục lớn dần mãi mà không ai để ý.

### Hai RPC mới

- `cache.get` → `GraphSnapshot | null` cho repo đang active.
- `cache.put { snapshot }` → host đóng dấu `repoId` từ session của chính nó rồi ghi.

## Luồng dữ liệu

```
mở panel
  │
  ├─ cache.get ──────────────► có snapshot?
  │                              │
  │                              ├─ có  → vẽ ngay: sidebar, window đầu, totalRows
  │                              │        layoutVersion = null (host chưa có layout)
  │                              └─ không → đường như hiện tại (loading rồi vẽ)
  │
  └─ refreshGraph() chạy song song
        │
        └─ build xong → so head sha + totalRows với snapshot
              ├─ giống  → nhận layoutVersion mới, KHÔNG đổi pixel
              └─ khác   → thay dữ liệu + báo nhẹ
        │
        └─ refresh thành công → cache.put
```

**Swap luôn xảy ra, kể cả khi refs không đổi.** Không phải để đổi pixel, mà để
webview có một `layoutVersion` còn sống mà cuộn. Vì vậy khoá hợp lệ không quyết
định *có fetch hay không* — nó chỉ quyết định swap là im lặng hay có báo.

**`headSha` lấy ở đâu.** Host đóng dấu bằng `GitService.getHeadHash()` — đã có
sẵn và được dùng ở đường `ui.openDiff`. Webview so nó với hash của branch hiện tại
trong `branches` vừa fetch, nên phía webview không cần thêm lời gọi nào.

**So sánh không tốn thêm lời gọi git.** Ban đầu định để host tính refs digest lúc
đọc, nhưng vì swap dù sao cũng xảy ra, webview chỉ cần so head sha (đã có trong
`branches` vừa fetch) và `totalRows` với giá trị trong snapshot. Cách này thiếu
chính xác một chiều — thêm một branch ở nơi khác không đổi cả hai — nhưng vì nó
chỉ chặn một dòng thông báo chứ không hiện pixel sai, độ chính xác đó không đáng
một lời gọi git trên đường tới hạn.

## Khoảng trống khi cuộn

Giữa lúc vẽ từ cache và lúc build thật xong, **host chưa có layout nào**, nên
`graph.getWindow` không gọi được. Cuộn trong khoảng đó không có gì để fetch.

- Các dòng ngoài ~60 dòng đã cache hiện **skeleton**: đúng chiều cao, không nội dung.
- `totalRows` lấy từ cache nên thanh cuộn dài đúng ngay từ đầu; nó chỉ nhảy nếu
  commit thật sự đã đổi.
- Build xong thì windowing trở lại bình thường và skeleton được lấp.

## Xử lý lỗi

| Tình huống | Kết quả |
|---|---|
| Không có snapshot | Đường hiện tại: loading rồi vẽ |
| Snapshot JSON hỏng | Coi như không có, không báo lỗi |
| Ghi cache thất bại (hết đĩa) | Refresh vẫn xong bình thường, lỗi chỉ ghi log |
| Refresh thất bại | **Không** ghi snapshot — nếu không, một lỗi git nhất thời sẽ thành thứ ta thấy ở mọi lần mở sau |
| Đổi repo | `cache.get` cho repo mới; miss thì như đường hiện tại |
| `globalStorageUri` chưa tồn tại | `mkdir -p` ở lần ghi đầu |

## Testing

Repo mock toàn bộ module `vscode` và không có `@vscode/test-electron`, nên cảm
giác "mở lên nhanh" **không test tự động được** — phải kiểm thủ công bằng F5.

Test tự động:

| File | Nội dung |
|---|---|
| `tests/extension/graph-cache.test.ts` | round-trip; cô lập theo repo; file hỏng → null; giới hạn 20 file theo `savedAt`; đọc song song trong lúc ghi không thấy file dở |
| `tests/extension/graph-cache-namespace.test.ts` | `cache.put` đóng dấu repoId của host chứ không lấy từ payload; `cache.get` trả null khi chưa có |
| `tests/webview/app-graph-cache.test.ts` | **`cache.get` resolve nhưng `graph.build` không bao giờ resolve → graph VẪN được vẽ** (đây là test cốt lõi); nhận im lặng khi không đổi; swap khi đổi; ghi snapshot sau refresh; KHÔNG ghi sau khi refresh lỗi |
| `tests/webview/app-graph-cache.test.ts` | cuộn trong khoảng trống hiện skeleton, không ném lỗi |

Checklist kiểm thủ công (F5):

1. Mở panel lần đầu ở repo lớn: có loading, cuối cùng vẽ xong.
2. Đóng cửa sổ, mở lại: graph hiện **ngay**, không có loading.
3. Commit mới ở terminal rồi mở lại: cache hiện trước, vài trăm ms sau đổi sang dữ liệu mới.
4. Không đổi gì rồi mở lại: không thấy nhấp nháy hay nhảy dòng nào.
5. Cuộn nhanh ngay khi vừa mở: thấy skeleton rồi được lấp, không lỗi.
6. Xoá thư mục `graph-cache` giữa chừng: mở lại vẫn chạy, chỉ là chậm như cũ.

## Roadmap

### Phase 1 — GraphCache và hai RPC

- **Deliverable:** `services/graph-cache.ts` (ghi nguyên tử, đọc không ném, giới hạn
  20 file), `cache.get` / `cache.put`, host đóng dấu repoId, webview gọi `cache.put`
  sau mỗi lần refresh thành công. **Chưa đọc cache ra để vẽ.**
- **Phụ thuộc:** không.
- **Nghiệm thu:** sau một lần mở, file snapshot tồn tại và đúng nội dung; refresh
  lỗi không tạo file; `npm run check` xanh.
- **Ship độc lập:** có — không đổi gì về mặt nhìn thấy, nhưng chứng minh được lớp lưu.

### Phase 2 — Vẽ từ cache

- **Deliverable:** `cache.get` lúc mount, vẽ ngay, swap im lặng hoặc có báo.
- **Phụ thuộc:** Phase 1.
- **Nghiệm thu:** checklist thủ công mục 2, 3, 4.
- **Ship độc lập:** có — đây là phase mang lại giá trị chính.

### Phase 3 — Skeleton cho khoảng trống

- **Deliverable:** dòng skeleton khi cuộn quá cửa sổ đã cache và build chưa xong.
- **Phụ thuộc:** Phase 2.
- **Nghiệm thu:** checklist thủ công mục 5.
- **Ship độc lập:** có.

### Phase 4 (tuỳ chọn) — `ai.providers` rời đường tới hạn

- **Deliverable:** không `await` `ai.providers` trong chuỗi mount; danh sách
  provider điền vào khi có.
- **Phụ thuộc:** không.
- **Ship độc lập:** có; bỏ được nếu đo thấy không đáng kể.
