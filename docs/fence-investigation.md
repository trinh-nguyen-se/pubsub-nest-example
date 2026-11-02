# Rào chống bỏ sót dòng: thử rào txid và kết luận

Spec `CMS GraphQL Sync` đề xuất: mỗi dòng `sync_change` mang `txid`, consumer chỉ nhận dòng khi
"mọi transaction cũ hơn đã kết thúc" (Postgres ≥ 13). Repo này đã dựng đúng như vậy rồi **bỏ**,
vì nó không đủ khi cursor là `seq`. Ghi lại để bước plan của dự án không phải thử lại.

## Bối cảnh

`EntityWriter` ghi hai câu trong **một** transaction:

```
BEGIN
  insert into supplier ...          -- câu ghi đầu tiên: Postgres cấp txid tại đây
  insert into sync_change ...      -- câu ghi thứ hai: identity cấp seq tại đây
COMMIT
```

Thứ tự `txid` phản ánh **lần ghi đầu tiên**, thứ tự `seq` phản ánh **lần ghi outbox**. Hai thứ tự
này có thể đảo nhau, và đó là gốc của vấn đề.

Rào `txid < xmin` chỉ bảo vệ khi dòng đang mở có `txid` nhỏ hơn dòng đã commit. Khi dòng đang mở có
`txid` **lớn** hơn nhưng `seq` **nhỏ** hơn, nó vừa vô hình (chưa commit) vừa nằm dưới cursor sau khi
dòng kia được đọc:

```
Tx B: ghi entity (txid 100)
Tx A: ghi entity (txid 101)          ← txid lớn hơn
Tx A: ghi outbox (seq 1)             ← seq nhỏ hơn, vẫn mở
Tx B: ghi outbox (seq 2), commit     ← seq lớn hơn, đã commit
```

Reader chạy sau khi B commit: `xmin = 101` (A đang chạy).

- Dòng `seq 2` có `txid 100` → `100 < 101` đúng → **được trả về**, cursor nhảy tới 2.
- Dòng `seq 1` có `txid 101` → không thoả rào, và cũng **không nhìn thấy** vì A chưa commit.
- A commit sau đó: `seq 1 < cursor 2` → consumer không bao giờ nhận.

Kịch bản này được tái hiện bằng `scripts/fence-lab.ts` (chế độ `none`) và bằng test
`advisory: txid và seq không thể đảo thứ tự` trong `apps/cms/test/fence.test.ts`, nơi chứng minh
advisory làm đúng điều mà rào txid không làm được.

## Vì sao không sửa được bằng "cắt cận trên tại dòng bị chặn"

Ý tưởng tự nhiên: chỉ trả các dòng có `seq` nhỏ hơn dòng bị chặn đầu tiên. Đã thử:

```sql
with snap as (select pg_snapshot_xmin(pg_current_snapshot()) as xmin),
     blocked as (select min(seq) from sync_change, snap where txid >= snap.xmin)
select ... where txid < snap.xmin and seq < coalesce(blocked.first_blocked, max)
```

Kết quả đo được (Postgres 16, hai transaction như trên):

```
xmin = 1238, first_blocked = null, rows = [ '2:1237' ]
changes -> [ 2 ]
```

`first_blocked` là `null` vì **dòng của transaction đang mở không nằm trong tầm nhìn MVCC**. Không
thấy thì không chặn được. Bảng `sync_change` không có cách nào tự khai báo "tôi sắp ghi seq 1".

## Ba phương án

1. **Khoá advisory lúc ghi** — đã chọn (`FENCE_STRATEGY=advisory`).
   Khoá được lấy ngay trước câu insert outbox, giữ tới `COMMIT`, nên thứ tự commit trùng thứ tự
   `seq`. Reader chỉ cần `seq > cursor`, API đúng như spec (`changes(afterSeq)`), cursor là một số.
   Cửa sổ khoá ngắn vì entity đã ghi xong trước đó. Cái giá: mọi transaction có thay đổi xếp hàng ở
   một khoá — chấp nhận được với đường ghi của CMS (người dùng sửa, không phải hàng nghìn TPS).

2. **Cursor là `txid`, không phải `seq`** — song song hoàn toàn, nhưng đổi hợp đồng.
   Đọc `order by txid, seq` với `txid < xmin`, cursor mã hoá `(txid:seq)`, consumer coi cursor là
   chuỗi mờ; `seq` chỉ còn để hiển thị. Đúng, nhưng `changes(afterSeq: Int!)` phải thành
   `changes(after: String)` và mọi consumer đổi kiểu lưu cursor. Đây là hướng đi nếu sau này CMS ghi
   dày đặc hoặc có batch lớn.

3. **Cursor `seq` trơn** — sai, chỉ dùng cho bài lab (`FENCE_STRATEGY=none`).

## Khuyến nghị cho dự án thật

- v1: `advisory`. Đơn giản, đúng, không đổi API, dễ giải thích cho team.
- Đo `pg_stat_activity` khi có batch import lớn: nếu thấy chờ khoá advisory đáng kể thì chuyển sang
  phương án 2 (cursor `txid`) — lúc đó đổi cả CMS lẫn consumer, nên làm trước khi có nhiều consumer.
- Dù chọn cách nào, `changes(afterSeq)` vẫn là đường bù bắt buộc: message bus mất message là chuyện
  bình thường.

Phần còn lại của spec vẫn đúng và đã dựng: outbox cùng transaction, message mỏng, tombstone, cursor
một chiều, consumer kéo dữ liệu qua GraphQL.
