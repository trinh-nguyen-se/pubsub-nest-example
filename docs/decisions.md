# Quyết định kỹ thuật

Ghi lại những chỗ đáng lẽ phải chọn, để người đọc spec không phải đoán.

## 1. Apollo Server mount qua Nest middleware, không dùng `@nestjs/graphql`

**Bối cảnh.** Spec yêu cầu SDL sinh tự động từ zod, hai endpoint `/graphql/{b2b|b2c}/v1` với hai
schema tách hẳn nhau, và nêu rủi ro "phiên bản Apollo và NestJS phải khớp nhau".

**Quyết định.** Dùng `@apollo/server` + `@as-integrations/express5` gắn vào Nest bằng middleware
(`GraphqlModule.configure`). Nest giữ DI, controller, lifecycle, shutdown hook.

**Vì sao.**

- `@nestjs/graphql` mạnh ở code-first decorator; schema ở đây sinh động, mỗi view một SDL, nên
  decorator chỉ thêm một lớp trung gian không cần thiết.
- Hai instance GraphQL trong một app là chỗ dễ vỡ nhất khi nâng version; mount trực tiếp loại bỏ
  biến số đó.
- Vẫn giữ nguyên hợp đồng HTTP của GraphQL (validation, introspection, error extensions) vì
  Apollo Server thật.

**Đánh đổi.** Mất playground mặc định và vài tiện ích của Nest; phải tự lo auth ở tầng middleware
(đã làm trong `apps/cms/src/graphql/auth.ts`) và tự start/stop server (đã làm trong
`graphql.module.ts`).

## 2. Khoá advisory lúc ghi, không dùng rào `txid` với cursor `seq`

**Quyết định.** `FENCE_STRATEGY=advisory` mặc định; `none` chỉ để làm bài lab.

**Bối cảnh.** Spec đề xuất thêm cột `txid` và chỉ trả dòng khi `txid < xmin`. Đã dựng đúng như vậy.

**Vì sao bỏ.** `txid` được cấp ở lần ghi đầu tiên của transaction (insert entity), `seq` ở lần ghi
outbox sau đó. Hai thứ tự đảo nhau được: dòng đang mở có thể có `txid` lớn hơn nhưng `seq` nhỏ hơn
dòng đã commit, nên nó vừa vô hình vừa nằm dưới cursor — cursor nhảy qua và dòng đó mất. Không sửa
được bằng "cắt cận trên tại dòng bị chặn" vì dòng đang mở không nằm trong tầm nhìn MVCC (đo được
`first_blocked = null`).

**Bằng chứng.** `docs/fence-investigation.md` có phân tích và số liệu; `pnpm lab` in cả hai chế độ;
`apps/cms/test/fence.test.ts` có test chứng minh advisory không thể đảo thứ tự `txid`/`seq`.

**Cái giá.** Đường ghi outbox tuần tự hoá ở một khoá. Cửa sổ khoá ngắn (sau khi entity đã ghi). Nếu
sau này có batch lớn, chuyển sang cursor `txid` (thiết kế ở `docs/fence-investigation.md`).

## 3. Hai consumer, một codebase

**Quyết định.** `packages/consumer-kit` chứa toàn bộ engine; `apps/consumer-b2b` và
`apps/consumer-b2c` chỉ là entrypoint + config.

**Vì sao.** B2B và B2C khác nhau ở **dữ liệu được thấy**, không khác ở cơ chế đồng bộ. Tách code sẽ
làm hai bên lệch nhau theo thời gian — đúng loại lỗi khó tìm nhất trong hệ sync.

## 4. Consumer tự dựng query từ contract

**Quyết định.** `GraphqlClient` dựng query từ `selection` trong contract sinh ra, không viết tay
từng entity.

**Vì sao.** Thêm field vào contract là consumer kéo thêm field đó mà không sửa code. Đổi tên field thì
query đổi theo, gate bắt được lệch SDL trước khi chạy.

**Đánh đổi.** Query không được tối ưu thủ công (không alias, không fragment). Với 200–1000 bản mỗi
lần kéo thì chưa phải vấn đề; nếu cần, thêm lớp chọn field theo nhu cầu.

## 5. Message mang `version`

**Quyết định.** Message có `version` dù consumer luôn kéo bản mới nhất.

**Vì sao.** `version` là thứ duy nhất cho phép lọc trùng và bỏ message đến muộn mà không cần gọi
GraphQL. Thiếu nó, mỗi message lặp thành một lần gọi mạng.

## 6. Ghi outbox sau khi publish (at-least-once), không phải trước (at-most-once)

**Quyết định.** Publish xong mới `update sync_change set published_at = now()`.

**Vì sao.** Crash giữa hai bước gây **gửi lặp** — vô hại vì consumer lọc theo version. Nếu đánh dấu
trước rồi publish, crash sẽ gây **mất message**, và mất message chỉ được bù ở nhịp reconcile.
Chọn phía an toàn hơn.

## 7. Redis pub/sub cho local, không giả lập độ bền

**Quyết định.** Dùng Redis pub/sub thật, chấp nhận mất message khi không có subscriber.

**Vì sao.** Đây chính là điều cần dạy: message bus không bền thì `changes()` phải gánh. Giả lập một
bus bền sẽ che mất bài học. Khi lên AWS, SQS đảm bảo độ bền còn `changes()` vẫn giữ vai trò bù.
