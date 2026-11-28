# Zalo Account checklist

Ngày ghi nhận hiện trạng: **2026-11-23**.

Checklist lưu lại kết quả đối chiếu Zalo Account của ChatbotX với `zca-js` và ZaloCRM để tham khảo khi triển khai dần. Đây là bản ghi hiện trạng và các mục cần hoàn thiện, **chưa phải kế hoạch triển khai**, chưa xác lập giai đoạn, lịch thực hiện hoặc cam kết hỗ trợ.

**Phạm vi:** Zalo Account cá nhân qua **`zca-js` 2.1.2 đang cài — 146 phương thức API**, QR/login và các listener event; đã đối chiếu cách ZaloCRM triển khai. Không bao gồm Zalo OA. “Đầy đủ” dưới đây là bao phủ khả năng SDK hiện có; từng API vẫn cần kiểm chứng bằng tài khoản thật.

**Ưu tiên:** **P0** = tính đúng đắn, bảo toàn dữ liệu, vận hành · **P1** = trải nghiệm Zalo đầy đủ · **P2** = quản trị và nghiệp vụ nâng cao · **P3** = tính năng chuyên biệt.

**Trạng thái:** `[x]` đã có nền tảng trong code, chưa đồng nghĩa đã kiểm chứng production · `[ ]` cần bổ sung hoặc hoàn thiện. Trạng thái được ghi nhận tại ngày nêu trên; kiểm tra lại source và kiểm chứng trước khi cập nhật checkbox.

## P0 · 1. Kết nối, socket và phiên đăng nhập

**Cập nhật P0.1:** các dòng dưới đã có implementation và kiểm thử tự động theo [bằng chứng triển khai](../plans/261123-0459-zalo-account-connection-socket-session-tdd/reports/implementation.md), [business/PostgreSQL](../plans/261123-0459-zalo-account-connection-socket-session-tdd/reports/business-implementation.md), [runtime tests](../apps/zalo-account-gateway/__tests__/zalo-account-runtime.test.ts) và [status/UI tests](../apps/builder/__tests__/zalo-account-status-query.test.tsx). Ba checkbox nền tảng `[x]` giữ nguyên trạng thái đối chiếu ban đầu; các mục hoàn thiện P0.1 giữ `[ ]` đến khi kiểm chứng provider → DB/API → UI và restart staging theo quy tắc hoàn thành cuối checklist; không coi fixture, mock hay PostgreSQL local là live Zalo. Các nhóm/ưu tiên ngoài P0.1 giữ nguyên bản đối chiếu.

- [x] QR login, reconnect, disconnect; xác minh UID khi kết nối lại.
  - Implementation/test: Đã có implementation và regression tự động; vẫn cần QR/reconnect/disconnect với provider thật.
- [x] Lease/fence chống nhiều gateway cùng sở hữu tài khoản; chặn callback từ runtime cũ.
  - Implementation/test: Đã có regression lease/fence và thứ tự durable bằng PostgreSQL thật; staging nhiều gateway/Redis restart chưa chạy.
- [x] Reconnect có backoff, jitter và giới hạn khi phiên không ổn định.
  - Implementation/test: Đã kiểm thử retry hữu hạn, jitter và hold; chưa kiểm chứng provider thật khi phiên chập chờn.
- [ ] Chỉ báo socket `connected` khi SDK thực sự phát sự kiện mở kết nối.
  - Implementation/test: Đã gate bằng SDK open event và test start chưa open; chờ xác nhận event thực tế.
- [ ] Tách trạng thái **Connection / gateway-runtime / socket Zalo**.
  - Implementation/test: Đã có projection Connection/lease/socket với freshness, test mismatch/Redis lỗi/old row; chờ kiểm chứng end-to-end.
- [ ] Xử lý đầy đủ `connected`, `disconnected`, `closed`, `error`.
  - Implementation/test: Đã có mapping và attempt fence trong adapter/runtime, regression callback đến muộn; chờ payload thật.
- [ ] Giữ close code và reason đã làm sạch; phân biệt ngắt thủ công, lỗi mạng, kết nối trùng, bị kick và hết phiên.
  - Implementation/test: Đã có safe closeCode/errorCategory; không lộ raw reason hay auth. Chờ xác nhận các nguyên nhân với provider thật.
- [ ] Chính sách riêng cho `1000`, `1006`, `3000`, `3003`; tránh reconnect tranh chấp với phiên khác.
  - Implementation/test: Đã kiểm thử manual stop, network retry và durable hold 3000/3003; chưa gây duplicate/kick trên tài khoản staging.
- [ ] Phân biệt lỗi đăng nhập tạm thời với mất quyền xác thực; không bắt quét QR lại chỉ vì lỗi mạng.
  - Implementation/test: Đã kiểm thử lỗi tạm thời/unknown không tự suy ra revoked; auth evidence mới đi đường reauthorization. Chờ provider thật.
- [ ] Timeout mở socket, timeout login và phát hiện runtime mắc kẹt.
  - Implementation/test: Đã kiểm thử deadline login/open và abort+settlement HTTP trên pinned SDK; chờ tài khoản thật.
- [ ] Hiển thị thời điểm kết nối/ngắt gần nhất, số lần reconnect, lần thử tiếp theo và lỗi gần nhất.
  - Implementation/test: Đã có UI/i18n và safe runtime timestamps/retry diagnostics; chờ đối chiếu trạng thái thực trên UI.
- [ ] Hiển thị thời điểm nhận event gần nhất, kèm ý nghĩa rõ ràng; không coi im lặng là mất kết nối.
  - Implementation/test: Đã test event sampling và fresh sample với lastEventAt cũ vẫn open; không heartbeat DB theo tin nhắn. Chờ provider thật.
- [ ] Phát realtime trạng thái tài khoản để UI cập nhật ngay; polling làm dự phòng.
  - Implementation/test: Đã có IDs-only realtime sau commit, status-only polling 30s và coalescing; chờ kiểm chứng end-to-end.
- [ ] Kiểm tra và khôi phục phiên sau gateway/Redis/worker restart.
  - Implementation/test: Đã có bounded cursor recovery, coalesced restart và test main/pool; gateway/Redis/worker restart staging chưa chạy.
- [ ] Refresh cookie/session nếu SDK có thay đổi, lưu lại dưới dạng mã hóa.
  - Implementation/test: Đã kiểm thử pinned SDK cookie mutation, encrypted CAS và hai thứ tự commit QR/refresh trên PostgreSQL thật; chưa có live cookie refresh.
- [ ] Hoàn thiện trạng thái QR: đã sinh, đã quét, chờ xác nhận, bị từ chối, hết hạn, đã hủy.
  - Implementation/test: Đã có pending/generated/scanned/waiting/declined/expired/cancelled và test terminal late callbacks; chờ QR thật.
- [ ] Quản lý `login`, `loginQR`, `getOwnId`, `getCookie`, `getContext`, `keepAlive` trong gateway; cookie/context nhạy cảm chỉ dùng nội bộ.
  - Implementation/test: login/loginQR/getOwnId/getCookie ở gateway; không thêm getContext export hoặc keepAlive polling vì không có health proof. Chờ kiểm chứng live; không hứa dùng mọi API SDK.

## P0 · 2. Lưu ảnh/file và media trên R2/S3

**Chính sách hiện tại:** ảnh, video, file và audio đủ điều kiện vẫn lưu R2. Sticker hiển thị từ CDN Zalo theo ID và bộ. GIF dùng URL nguồn Zalo đã kiểm tra. Luồng mới không lưu sticker hoặc GIF lên R2. Bản lưu cũ giữ theo chính sách lưu trữ hiện có.

**Cập nhật 2026-11-23:** phần code P0 · 2 đã triển khai và qua lint, typecheck, regression local trên nhánh `feat/zalo-account-media-r2`; xem [báo cáo kiểm chứng](../plans/261123-0500-zalo-account-media-r2-tdd/reports/implementation-and-verification.md). Cờ lưu trữ mặc định tắt, migration chưa áp dụng và các gate staging/R2 thật còn chờ. Checkbox vận hành dưới đây được giữ cho đến khi có bằng chứng chạy thực tế.

- [x] File gửi từ ChatbotX có đường upload/lưu storage; API gửi bằng URL có bước tải về storage.
- [ ] Tự tải **ảnh/file nhận từ Zalo** về R2/S3.
- [ ] Tự lưu media từ **own-echo**: tài khoản gửi bằng điện thoại/Zalo PC/Web.
- [ ] Dùng cùng cơ chế lưu cho DM, nhóm và tin lịch sử.
- [ ] Mở rộng lưu video, voice/audio và media trong các loại card được hỗ trợ.
- [ ] Lưu thumbnail/poster, ảnh preview và các biến thể cần cho hiển thị.
- [ ] Lưu avatar tài khoản, khách hàng, thành viên và nhóm; cập nhật khi nguồn thay đổi.
- [ ] Lưu cover khi thực sự sử dụng trong giao diện hồ sơ.
- [x] Hiển thị sticker và GIF từ CDN Zalo. Luồng mới bỏ qua tải lên R2, kể cả khi worker phát hiện GIF bằng nội dung file.
- [ ] Giữ bản gốc; bản tối ưu/thumbnail là object riêng, không ghi đè bản gốc.
- [ ] Có trạng thái `pending / downloading / stored / failed / expired`.
- [ ] Có retry giới hạn, thời điểm thử gần nhất, lỗi và số lần thử.
- [ ] Ưu tiên tải sớm để giảm nguy cơ URL Zalo hết hạn hoặc bị thu hồi.
  - Media mới được đưa vào hàng đợi sau khi ghi DB. Inbox xem trước ảnh/GIF từ nguồn Zalo nếu URL còn dùng được, thông qua link tạm đã kiểm tra quyền và trạng thái thu hồi. Khi mở lại hội thoại, Inbox ưu tiên bản R2/S3 đã lưu. URL gốc vẫn được mã hóa trong bản ghi asset. [Đường nhận media](../packages/business/src/media/zalo-account-ingress.ts) · [Kiểm thử giao diện ảnh](../apps/builder/__tests__/message-item-attachments.test.tsx).
- [ ] Lưu tên file gốc, MIME thực tế, size, checksum, kích thước ảnh/video và duration.
- [ ] Giữ provider URL/ID và object key riêng; không dùng URL ký tạm thời làm định danh lưu trữ.
- [ ] Phân vùng object theo workspace/account/conversation; không trộn dữ liệu giữa workspace.
- [ ] Phân quyền xem/download; dùng signed URL hoặc proxy phù hợp.
- [ ] Chống tải URL nội bộ, redirect không an toàn, file quá lớn và MIME giả.
- [ ] Download dạng stream, giới hạn đồng thời, không giữ toàn bộ file lớn trong RAM.
- [ ] Dọn file tạm và multipart upload dang dở.
- [ ] Chống tạo object trùng khi event/job được xử lý lại.
- [ ] Backfill các attachment cũ đang chỉ giữ URL Zalo.
- [ ] Đối soát attachment DB ↔ object R2/S3; phát hiện object thiếu và object mồ côi.
- [ ] Chính sách lưu trữ/xóa có xét tin thu hồi, tài nguyên dùng chung và yêu cầu giữ lịch sử.

## P0 · 3. Thu hồi, xóa và xem lại để tracking

**Cập nhật triển khai 2026-11-23:** đã thêm ledger DM/nhóm, giữ original/attachment đã có, API + UI xem lại theo quyền, local hide riêng, native undo/delete-only-me/deleteChat, projection server/client và recovery hữu hạn. Xem [bằng chứng triển khai](../plans/261123-0500-zalo-account-recall-tracking-tdd/reports/implementation-api-ui.md) và [review](../plans/261123-0500-zalo-account-recall-tracking-tdd/reports/implementation-review.md). Giữ các mục hoàn thiện dưới đây chưa tick đến khi đủ final gate, migration và kiểm chứng disposable DM/group; không coi mock/unit test là live provider proof. Native mặc định tắt. File chưa ingest thuộc P0 · 2, không thể tải lại sau thu hồi. Receipt/reaction vẫn latest-state 90 ngày; không có lịch sử sự kiện vô hạn mới.

- [x] Nhận sự kiện undo; Message được đánh dấu xóa mềm.
- [x] Có tombstone cho undo nhóm để tin đến muộn không khôi phục tin đã thu hồi.
- [ ] Phân biệt rõ **thu hồi trên Zalo / xóa phía mình trên Zalo / xóa nội bộ ChatbotX**.
- [ ] Giữ nguyên nội dung và attachment đã lưu khi Zalo thu hồi.
- [ ] Bubble ghi **“Đã thu hồi trên Zalo”**, không dùng nhãn chung dễ nhầm.
- [ ] Có nút **“Xem nội dung đã lưu”** theo quyền truy cập.
- [ ] Cho xem/download ảnh/file đã lưu trước khi thu hồi.
- [ ] Lưu thời điểm provider thu hồi và thời điểm hệ thống nhận sự kiện.
- [ ] Lưu actor nếu event cung cấp; không suy đoán người thu hồi khi thiếu dữ liệu.
- [ ] Giữ receipt/reaction lịch sử phục vụ tracking thay vì xóa khỏi lịch sử nghiệp vụ.
- [ ] Audit thao tác xem/download nội dung đã thu hồi nếu cần kiểm soát truy cập.
- [ ] Hoàn thiện tombstone/order handling cho DM, không chỉ nhóm.
- [ ] Không đánh dấu các reply là đã bị thu hồi chỉ vì tin gốc bị thu hồi; kiểm tra tác động của hàm soft-delete dùng chung.
- [ ] Trạng thái rõ khi chỉ nhận được sự kiện thu hồi, chưa từng nhận nội dung gốc.
- [ ] Tách retention nghiệp vụ khỏi thao tác thu hồi; không để cleanup tự xóa bản lưu cần tracking.
- [ ] Kiểm chứng và mở thao tác `undo`, `deleteMessage`, `deleteChat` theo đúng ngữ nghĩa từng API.

## P0 · 4. Toàn vẹn tin nhắn và khả năng phục hồi

**Cập nhật triển khai 2026-11-23:** đã thêm metadata có version, placeholder hữu hạn, đối soát nhiều provider ID với primary ổn định, repair local không gửi lại, admission và lỗi an toàn, API/Inbox xem trạng thái theo yêu cầu. Xem [bằng chứng nhánh nguồn](../plans/261123-0500-zalo-account-message-integrity-recovery-tdd/reports/implementation.md) và [đối soát tích hợp](../plans/261123-zalo-account-p0-integration/reports/integration.md). Cờ producer mặc định tắt; giữ checkbox hoàn thiện chưa tick đến khi đủ gate DB, coverage và live provider; chưa áp migration.

- [x] Canonical send, command ID, send-attempt và trạng thái `pending / applied / failed / unknown`.
- [x] Chống tự gửi lại khi kết quả gửi chưa xác định.
- [ ] Mọi loại gửi mới đều đi qua cùng cơ chế canonical send.
- [ ] Đối chiếu kết quả API gửi với own-echo, bao gồm một lệnh sinh nhiều message ID.
- [ ] Giữ đủ `msgId`, `cliMsgId`, thread/account identity, timestamp và loại tin.
- [ ] Xử lý event trùng, sai thứ tự, đến muộn và echo đến trước send result.
- [ ] Không bỏ im lặng tin chưa hỗ trợ: có bubble placeholder và metadata chọn lọc.
- [ ] Có metric loại payload chưa hỗ trợ, payload lỗi và thiếu identity.
- [ ] Giữ schema/version của dữ liệu chuẩn hóa để có thể sửa và đọc lại dữ liệu cũ.
- [ ] Rate limit theo account và nhóm thao tác, có `retryAfter`/cooldown.
- [ ] Phân loại thao tác đọc có thể retry và thao tác ghi có thể đã áp dụng.
- [ ] Hiển thị rõ lỗi nhận, lỗi lưu media và lỗi gửi; có thao tác phục hồi phù hợp.

## P1 · 5. Tin nhắn và các loại nội dung

**Pha 1 · Kiểm thử cục bộ:** DM, nhóm và own-echo có metadata hiển thị riêng cho Zalo Account. Inbox đọc video/voice và ảnh thẻ từ luồng archive riêng tư. Tài nguyên độc lập vừa tải xong cần tải lại hội thoại để thấy trạng thái mới. TTL được lưu theo payload, phần tự biến mất chưa xác minh trên Zalo thật. Các dòng gộp nhận và gửi vẫn mở đến khi kiểm chứng phần gửi.

**Pha 2 · Kiểm thử cục bộ:** composer và API có payload có kiểu cho link, danh thiếp, thẻ ngân hàng, video, voice và nhiều file kèm caption. Send ledger giữ ID đã xác nhận khi gửi được một phần và ghi nhận ACK thiếu ID. Chuyển tiếp text và gửi bản sao ảnh/file đã lưu dùng tin nguồn đã qua kiểm tra quyền. Các khả năng mới giới hạn theo account. Gửi media, codec, TTL và chuyển tiếp qua provider thật vẫn chờ staging.

- [x] Text, ảnh, file và metadata quote cơ bản.
- [ ] Nhận/gửi video; player inline, poster, duration và download.
- [ ] Nhận/gửi voice/audio; player, duration và ghi âm từ composer.
- [x] Nhận/hiển thị GIF đúng loại từ URL Zalo; bảo toàn animation.
- [x] Giữ mô tả ảnh đến qua socket trong cùng tin nhắn DM hoặc nhóm.
- [x] Nhận/hiển thị link preview: tiêu đề, mô tả, thumbnail, URL gốc.
- [ ] Gửi link bằng `sendLink`, tận dụng `parseLink` khi phù hợp.
- [ ] Nhận/gửi danh thiếp bằng `sendCard`.
- [x] Render vị trí/bản đồ khi payload cung cấp tọa độ hoặc link hợp lệ.
- [ ] Render bank card/QR chuyển khoản; gửi qua `sendBankCard`.
- [x] Render thông báo cuộc gọi: đến/đi/nhỡ, thoại/video, thời lượng nếu có.
- [x] Không coi render thông tin cuộc gọi là khả năng thực hiện cuộc gọi.
- [x] Phân loại theo cả `msgType`, `content.action` và shape nội dung.
- [x] Hỗ trợ các biến thể payload như `recommended`/`recommened`, JSON trong `params`.
- [x] Giữ rich text/styles: đậm, nghiêng, gạch chân, gạch ngang, màu, cỡ chữ, danh sách.
- [ ] Gửi styles/urgency bằng các trường SDK thực sự hỗ trợ.
- [ ] Kiểm chứng TTL/tin tự biến mất trước khi đưa vào UI; lưu rõ giá trị provider.
- [ ] Forward text/media qua `forwardMessage`, giữ thông tin nguồn nếu SDK hỗ trợ.
- [ ] Hoàn thiện `sendMessage`, `sendVideo`, `sendVoice`, `uploadAttachment` với progress, cancel và lỗi rõ ràng.

## P1 · 6. Sticker đầy đủ như ZaloCRM

**Pha 3 · Kiểm thử cục bộ:** nhận diện sticker có category/type, cache theo phiên, tìm và duyệt bộ, gửi qua hàng đợi Inbox, xem sticker tĩnh/động từ CDN Zalo và dùng xem gần đây/yêu thích theo người dùng và tài khoản. Đã kiểm tra fallback, giảm chuyển động, cache và ảnh sticker tải trực tiếp theo ID. Picker mở với từ khóa “vui” như ZaloCRM và duyệt các bộ theo ID Zalo trả về. Còn xác nhận trên Zalo thật về payload các bộ sticker và own-echo của lệnh gửi.

**Pha 3 · Kiểm thử cục bộ:** nhận diện sticker có category/type, cache theo phiên, tìm và duyệt bộ, gửi qua hàng đợi Inbox, xem sticker tĩnh/động từ archive và dùng xem gần đây/yêu thích theo người dùng và tài khoản. Đã kiểm tra fallback, giảm chuyển động và cache. Còn xác nhận trên Zalo thật về payload các bộ sticker và own-echo của lệnh gửi.

- [x] Nhận và lưu sticker identity/category/type.
- [x] Lấy metadata qua `getStickersDetail`, có batch và cache.
- [x] Hiển thị sticker static.
- [x] Hiển thị animated WebP hoặc sprite với `totalFrames`/`duration`.
- [x] Fallback khi animation, metadata hoặc tài nguyên hết hạn.
- [x] Tìm sticker qua `getStickers` và `searchSticker`.
- [x] Duyệt bộ sticker qua `getStickerCategoryDetail`.
- [x] Picker tìm kiếm, bộ sticker, gần đây và yêu thích nội bộ.
- [ ] Gửi qua `sendSticker`, đối chiếu own-echo chống trùng.
- [x] Preview sticker trong reply, danh sách hội thoại và lịch sử.
- [x] Giới hạn animation khi ngoài màn hình; hỗ trợ giảm chuyển động.
- [x] Tách cache tài nguyên công khai khỏi quyền dùng tài khoản Zalo để gọi SDK.

## P1 · 7. Album, attachment, reply và mention

**Pha 2 · Kiểm thử cục bộ:** chuẩn bị gửi nhiều ảnh/file và caption có thứ tự trong Inbox/API. Các dòng bên dưới tiếp tục theo dõi việc xác nhận batch trên Zalo thật và cách hiển thị album nhận ở pha 4.

**Pha 4 · Kiểm thử cục bộ:** Inbox gom các ảnh có layout ID, giữ vị trí ảnh khi ảnh đến sai thứ tự hoặc bị thu hồi. Quote dùng provider ID kèm thời gian và mở được tin cũ trong cửa sổ chi tiết. Cho chọn thành viên để mention và kiểm tra lại quyền trước khi gửi vào nhóm. Thư viện tìm nội dung trong từng hội thoại bằng cursor. Còn xác nhận inbound album, mention bản thân và mention toàn nhóm trên Zalo thật. Hồ sơ thành viên chỉ có dữ liệu được phép từ hội thoại và roster, nên có thể thiếu avatar.

- [ ] Gửi nhiều ảnh/file khi SDK cho phép.
- [x] Lưu metadata album: group/layout ID, vị trí và tổng số ảnh.
- [x] Render album thành một cụm, giữ đúng thứ tự.
- [x] Hỗ trợ caption và quy tắc text kèm media nhất quán giữa Inbox/API.
- [x] Quote preview cho ảnh/video/file/sticker/card, không hiện raw JSON.
- [x] Hiển thị tên/avatar người gửi tin gốc thay vì chỉ UID.
- [x] Nhảy đến tin gốc; có fallback nếu tin ngoài trang hoặc đã thu hồi.
- [x] Thống nhất cách lưu/đọc quote giữa DM và nhóm.
- [x] Composer chọn người để gửi mention thật.
- [ ] Hỗ trợ mention bản thân, thành viên và toàn nhóm nếu provider/quyền cho phép.
- [x] Tính offset mention/styles đúng với Unicode và emoji.
- [x] Popup hồ sơ khi click avatar, tên người gửi hoặc mention.
- [x] Tìm kiếm và thư viện media/file/link trong từng hội thoại.

## P1 · 8. Delivered, seen, typing và reaction

**Pha 1 · Kiểm thử cục bộ:** Inbox hiển thị trạng thái DM, đếm receipt nhóm, popup có giới hạn, typing tự hết hạn và reaction theo kênh. Gửi reaction, request lịch sử reaction và các receipt outbound đã nối qua API có kiểm tra quyền. Cấu hình mặc định tắt; thay đổi, gỡ reaction, hiệu lực receipt và dữ liệu lịch sử còn chờ Zalo staging.

Đã kiểm thử hồi quy reaction từ tài khoản kết nối và người đối thoại, kể cả
payload lịch sử và reaction trỏ đến ID phụ của cùng tin nhắn. Cần đối chiếu
hiển thị trên tài khoản Zalo thật.

- [x] Nhận delivered/seen/typing/reaction; gửi typing đã có đường xử lý.
- [x] Hiển thị nhất quán trạng thái gửi/đã giao/đã xem cho DM.
- [x] Hiển thị số người đã giao/đã xem trong nhóm.
- [x] Popup danh sách người đã giao/đã xem nếu dữ liệu provider đủ.
- [x] Typing DM/nhóm với tên actor nếu có và tự hết hạn.
- [x] Reaction DM hiển thị đầy đủ như nhóm.
- [ ] Gửi/thay đổi/gỡ reaction qua `addReaction` theo contract SDK.
- [x] Popup người reaction, emoji, thời điểm nếu có.
- [ ] Đồng bộ reaction cũ qua `requestOldReactions`/`old_reactions`.
- [x] Phân biệt nhận read receipt với gửi read receipt lên Zalo.
- [ ] Tích hợp `sendSeenEvent`, `sendDeliveredEvent` theo thiết lập tài khoản/hội thoại.
- [x] Không để “đánh dấu đã đọc trong CRM” âm thầm đồng nghĩa với “đã đọc trên Zalo”.
- [x] Không tạo customer activity/MAC từ receipt/reaction của nhóm.

## P1 · 9. Đồng bộ lịch sử và bắt kịp sau offline

**Pha 2 · Kiểm thử cục bộ:** đã có phân trang có giới hạn, checkpoint bền vững, đồng bộ thủ công cho các hội thoại đã có liên kết và đường nhập tin lịch sử độc lập. Inbox báo số tin đã xử lý, media đã đưa vào hàng đợi và trạng thái một phần. Lần chạy không khẳng định đã có toàn bộ lịch sử Zalo. Cần xác nhận cửa sổ nhóm, thứ tự cursor DM và receipt/reaction lịch sử trên Zalo thật.

- [ ] DM history qua `requestOldMessages` và `old_messages`.
- [ ] Group history qua `getGroupChatHistory`.
- [x] Đồng bộ thủ công theo account/hội thoại/phạm vi provider cho phép.
- [ ] Đồng bộ ban đầu và bắt kịp sau reconnect.
- [x] Cursor/checkpoint bền vững, chống cursor lặp và trang lặp.
- [x] Tiến độ: số trang, số tin, số media, lỗi, partial/complete và điểm tiếp tục.
- [ ] Chống trùng giữa history, realtime và own-echo.
- [x] Lưu timestamp gốc; không biến tin cũ thành tin mới.
- [x] Tin lịch sử không chạy lại automation, thông báo và tính hoạt động như tin mới.
- [x] Tôn trọng tombstone thu hồi và policy nhóm khi import.
- [ ] Backfill reaction/receipt nếu provider cung cấp.
- [x] Phân biệt “đã đọc hết dữ liệu provider trả” với “đã có toàn bộ lịch sử Zalo”.

## P1 · 10. Hồ sơ khách hàng và dữ liệu định danh

**Pha 3 · Kiểm thử cục bộ:** hồ sơ Zalo đọc theo account và quyền hội thoại, giữ nguồn/thời điểm theo từng trường, mở theo nhu cầu và tách khỏi tên CRM. Nhân viên thiếu quyền điện thoại không thấy số công khai. Đã tạo migration và cần áp dụng theo quy trình triển khai. Còn kiểm chứng trường do provider trả, tình huống hồ sơ ẩn, avatar lớn và gợi ý liên kết khi dữ liệu xung đột.

- [x] Friend sync hiện lưu UID, tên và avatar.
- [ ] Chuẩn hóa chung dữ liệu từ `getUserInfo`, `getAllFriends`, `findUser`.
- [x] Lưu tên Zalo gốc, tên hiển thị theo account và tên CRM riêng biệt.
- [ ] Lưu `globalId`, username nếu có; dùng làm tín hiệu liên kết khách hàng.
- [x] Lưu giới tính, ngày/năm sinh theo mức chi tiết provider trả.
- [x] Lưu số điện thoại công khai kèm nguồn; không coi là số đã xác minh.
- [x] Lưu bio/status, cover, thông tin business và thời điểm profile cập nhật.
- [ ] Lưu quan hệ bạn bè, block và các cờ trạng thái có ý nghĩa nghiệp vụ.
- [x] Lưu thời điểm thu thập, nguồn API và account đã nhìn thấy dữ liệu.
- [x] Refresh profile khi mở hồ sơ hoặc theo TTL; có cache/batch.
- [x] Không ghi đè trường khách hàng đã chỉnh thủ công.
- [x] Dữ liệu thiếu/ẩn không tự xóa dữ liệu đã lưu.
- [ ] Avatar lớn qua `getFullAvatar`, `getAvatarUrlProfile` khi cần.
- [x] Popup hồ sơ người gửi nhóm mà không tự tạo Contact khách hàng.
- [ ] Gợi ý liên kết/merge có kiểm tra xung đột; không tự gộp chỉ theo một tín hiệu chưa kiểm chứng.

## P1 · 11. Bạn bè, tìm kiếm và presence

**Pha 4 · Kiểm thử cục bộ:** tìm theo số/username, chọn kết quả có token theo account, đọc danh sách và xác nhận thao tác quan hệ trong cài đặt. Presence tải khi cần với TTL ngắn; vắng trong danh sách online vẫn là chưa biết. Lời mời đến dựa trên event đã nhận. Thao tác provider cần bật theo account và còn chờ đối chiếu với tài khoản thật.

- [x] Tìm bằng `findUser`, `findUserByUsername`.
- [x] Tra cứu theo số điện thoại qua `getMultiUsersByPhones` khi phù hợp.
- [x] Mở hội thoại sau tra cứu hợp lệ. Nếu chưa có liên hệ, tạo liên hệ cho UID đã xác minh mà không gửi tin nhắn.
- [ ] Gửi lời mời bằng `sendFriendRequest`.
- [ ] Chấp nhận/từ chối/hủy bằng `acceptFriendRequest`, `rejectFriendRequest`, `undoFriendRequest`.
- [ ] Danh sách lời mời đã gửi và trạng thái qua `getSentFriendRequest`, `getFriendRequestStatus`.
- [x] Danh sách lời mời nhận cập nhật từ event; không giả định có API snapshot nếu SDK không cung cấp.
- [ ] Hủy bạn bằng `removeFriend`.
- [ ] Block/unblock bằng `blockUser`, `unblockUser`; quản lý chặn xem feed bằng `blockViewFeed`.
- [ ] Alias hai chiều qua `getAliasList`, `changeFriendAlias`, `removeFriendAlias`.
- [ ] Tận dụng `getFriendRecommendations`, `getCloseFriends` cho giao diện phù hợp.
- [x] Presence qua `getFriendOnlines`, `lastOnline`, có TTL và giới hạn truy vấn.
- [x] Phân biệt online/offline/ẩn trạng thái/không biết.
- [x] Tôn trọng `show_online_status`; không suy ra offline chỉ vì vắng trong danh sách online.
- [ ] Nhận đủ `friend_event`: add/remove/request/undo/reject/seen/block/unblock/block-call/pin.
- [x] Lịch sử quan hệ và thao tác theo account; không xóa khách chỉ vì không còn trong friend snapshot.

## P1 · 12. Thông tin và quản trị nhóm

**Pha 1 · Kiểm thử cục bộ:** trang quản lý tải chi tiết và danh sách thành viên theo nhu cầu. Chi tiết tách vai trò và hạn chế Zalo khỏi thiết lập Inbox; roster có cursor theo phiên bản, tải tối đa 50 người và báo khi Zalo hạn chế hoặc trả thiếu. Luồng sự kiện có kiểm tra membership và chống trùng; nghiệm thu socket trên tài khoản thật vẫn để mở.

**Pha 2 · Kiểm thử cục bộ:** đã nối các thao tác tạo, quản trị thành viên, ảnh/tên, duyệt, chặn và lời mời. Kiểm tra vai trò ngay trước khi gọi Zalo và giữ kết quả theo mã lệnh để đối soát khi timeout. Các thao tác đã hỗ trợ mở mặc định cho quản trị viên đủ quyền. Sửa settings toàn bộ và nâng community vẫn khóa. Các thao tác ghi bên dưới còn chờ nghiệm thu trên nhóm Zalo thử.

Gửi và nhận mặc định bật cho nhóm đã xác minh. Hệ thống phát hiện nhóm sau khi
socket kết nối và khi tài khoản tham gia nhóm. Giao diện cài đặt nhóm chỉ hiện
ba chế độ tự động hóa: Tắt mặc định, Chỉ khi được nhắc, và Mọi tin nhắn.

- [x] Group list, Inbox, receive/send policy, automation mode và kill switch đã có nền tảng.
- [x] Lưu mô tả, loại nhóm/community, owner/admin và settings ngoài metadata cơ bản.
- [x] Xem thành viên qua `getGroupMembersInfo`; có phân trang và cờ snapshot chưa đầy đủ.
- [x] Phân biệt owner/admin/member và quyền thực tế của account hiện tại.
- [ ] Tạo nhóm bằng `createGroup`.
- [ ] Đổi tên/avatar bằng `changeGroupName`, `changeGroupAvatar`.
- [ ] Thêm/mời/xóa thành viên bằng `addUserToGroup`, `inviteUserToGroups`, `removeUserFromGroup`.
- [ ] Thêm/gỡ phó nhóm bằng `addGroupDeputy`, `removeGroupDeputy`.
- [ ] Chuyển owner bằng `changeGroupOwner`.
- [ ] Chặn/gỡ chặn/xem người bị chặn bằng `addGroupBlockedMember`, `removeGroupBlockedMember`, `getGroupBlockedMember`.
- [ ] Lấy/duyệt yêu cầu vào nhóm bằng `getPendingGroupMembers`, `reviewPendingMemberRequest`.
- [ ] Xem link và thông tin link qua `getGroupLinkDetail`, `getGroupLinkInfo`.
- [ ] Bật/tắt link bằng `enableGroupLink`, `disableGroupLink`; tham gia bằng `joinGroupLink`.
- [ ] Quản lý hộp lời mời bằng `getGroupInviteBoxInfo`, `getGroupInviteBoxList`, `joinGroupInviteBox`, `deleteGroupInviteBox`.
- [ ] Sửa settings qua `updateGroupSettings`, hiển thị ý nghĩa từng quyền.
- [ ] Rời nhóm/giải tán bằng `leaveGroup`, `disperseGroup`.
- [ ] Kiểm chứng nâng cấp community bằng `upgradeGroupToCommunity`.
- [ ] Nhận đầy đủ `group_event`, cập nhật metadata/quyền ngay.
  - Luồng đã nối và kiểm tra với payload cố định. Chờ xác nhận loại sự kiện và khóa sắp thứ tự bằng tài khoản Zalo thử.
- [ ] Render system message: vào/rời/bị xóa, đổi admin, tên/avatar/settings, link và topic.
- [ ] Khi bị xóa khỏi nhóm hoặc mất quyền, cập nhật khả năng nhận/gửi; giữ lịch sử cũ.
- [ ] Tận dụng `getRelatedFriendGroup` cho ngữ cảnh nhóm chung khi phù hợp.
  - Đã nối thao tác đọc dành cho thành viên đã xác minh là bạn. Chờ xác nhận trên tài khoản có gói phù hợp.
- [x] Thành viên nhóm vẫn là identity/profile nhóm; chỉ tạo Contact khi có hành động chuyển đổi rõ ràng.

## P2 · 13. Nhãn Zalo và tag ChatbotX

**Pha 3 · Kiểm thử cục bộ:** đã có danh sách nhãn theo thứ tự, màu và liên kết tag. Sửa tên/màu/emoji dùng cả phiên bản và mã kiểm tra nội dung danh sách. Sync thủ công và khi reconnect dùng cùng hàng đợi. Reconnect tự đồng bộ nhãn mặc định. Tạo và xóa nhãn vẫn chờ xác nhận cách cấp ID và tác động trên Zalo thật.

- [x] Có `getLabels`, `updateLabels`, mapping và cập nhật nhãn đã map.
- [x] Hiển thị nhãn native, màu/thứ tự nếu payload cung cấp.
- [x] UI phân biệt tag có liên kết định nghĩa nhãn Zalo của tài khoản và tag ChatbotX.
- [ ] Kiểm chứng tạo/đổi tên/xóa nhãn native bằng whole-document update.
- [x] Sync sau reconnect và sync thủ công, có tiến độ và lần đồng bộ thành công gần nhất.
- [x] Hiển thị trạng thái conflict, partial, pending, unknown và thao tác đối soát.
- [x] Không mất label/assignment không liên quan khi sửa một hội thoại.
- [x] Không xóa mapping vì snapshot rỗng, stale hoặc chưa hoàn chỉnh.
- [x] Hiển thị liên kết định nghĩa nhãn trên DM và nhóm được phép quản lý.

## P2 · 14. Thiết lập hội thoại native

**Pha 4 · Kiểm thử cục bộ:** đọc thiết lập theo đúng thread và ContactInbox. Sau mỗi thao tác, đọc lại giá trị trên Zalo. Trường chưa có bằng chứng hiển thị là chưa rõ. PIN được loại tại gateway; cập nhật và reset PIN vẫn chờ nghiệm thu. Các thiết lập đã hỗ trợ có thể ghi theo quyền tài khoản.

- [ ] Đọc/ghi pin qua `getPinConversations`, `setPinnedConversations`.
- [ ] Đọc/ghi mute qua `getMute`, `setMute`.
- [ ] Đọc/ghi archive qua `getArchivedChatList`, `updateArchivedChatList`.
- [ ] Đọc/ghi unread mark qua `getUnreadMark`, `addUnreadMark`, `removeUnreadMark`.
- [ ] Đọc/ghi auto-delete qua `getAutoDeleteChat`, `updateAutoDeleteChat`.
- [ ] Hội thoại ẩn qua `getHiddenConversations`, `setHiddenConversations`.
- [ ] Quản lý PIN ẩn qua `updateHiddenConversPin`, `resetHiddenConversPin`.
- [x] Hiển thị riêng thiết lập Zalo và thiết lập CRM, tránh ghi đè lẫn nhau.
- [ ] Đồng bộ thay đổi từ thiết bị khác khi event/API cho phép.

## P2 · 15. Poll, note, board và reminder

- [ ] Render poll: câu hỏi, lựa chọn, trạng thái khóa và kết quả.
- [ ] Tạo/đọc poll qua `createPoll`, `getPollDetail`.
- [ ] Thêm lựa chọn, vote, khóa, share qua `addPollOptions`, `votePoll`, `lockPoll`, `sharePoll`.
- [ ] Note qua `createNote`, `editNote`.
- [ ] Board/topic qua `getListBoard`, `getFriendBoardList`.
- [ ] Reminder qua `createReminder`, `editReminder`, `removeReminder`.
- [ ] Danh sách/chi tiết/phản hồi qua `getListReminder`, `getReminder`, `getReminderResponses`.
- [ ] Lưu thời gian, timezone, lặp lại, người tạo/sửa và trạng thái phản hồi.
- [ ] Nhận event pin/unpin/reorder/topic/board và reminder accept/reject.
- [ ] Phân biệt reminder native Zalo với lịch hẹn/nhắc việc của ChatbotX.

## P2 · 16. Profile, avatar và thiết lập tài khoản

- [x] Thông tin chính chủ qua `fetchAccountInfo`, `getUserInfo`.
- [x] Sửa profile/bio qua `updateProfile`, `updateProfileBio`.
- [x] Danh sách avatar qua `getAvatarList`.
- [x] Đổi/xóa/dùng lại avatar qua `changeAccountAvatar`, `deleteAvatar`, `reuseAvatar`.
- [x] Lấy QR profile qua `getQR`; phân biệt với QR đăng nhập.
- [x] Đọc business account/package qua `getBizAccount`.
- [x] Đọc/ghi settings qua `getSettings`, `updateSettings`.
- [ ] Thiết lập ngôn ngữ qua `updateLang`.
- [ ] Kiểm chứng trạng thái hoạt động qua `updateActiveStatus`.
- [x] Chỉ hiển thị các settings có contract và ý nghĩa đã được xác nhận.
- [ ] Proxy HTTP/SOCKS theo account nếu cần; kiểm tra kết nối và giữ bí mật thông tin proxy.

> Pha 5 đã có API/CLI và giao diện tài khoản. Quyền ghi yêu cầu quản trị tài khoản và xác minh phiên Zalo. Cần xác minh phiên Zalo thật cho thao tác ghi, ngôn ngữ và trạng thái hoạt động.

## P2 · 17. Quick message và auto-reply native

**Pha 6 · Kiểm thử cục bộ:** đã có danh sách, thêm/sửa/xóa mẫu Zalo, đính kèm
một ảnh hoặc xác nhận thay/gỡ ảnh. Ảnh hiển thị qua URL Zalo khi chờ lưu nền và
ưu tiên bản R2/S3 đã lưu. Auto-reply Business có đọc và xóa theo đúng quy tắc
được chọn. Tạo/sửa auto-reply và xác nhận giờ theo thiết bị còn chờ Zalo thật.

- [x] Quick message CRUD qua `getQuickMessageList`, `addQuickMessage`, `updateQuickMessage`, `removeQuickMessage`.
- [x] Preview nội dung/media của quick message và lưu media cần thiết trên R2/S3.
- [ ] Auto-reply CRUD qua `getAutoReplyList`, `createAutoReply`, `updateAutoReply`, `deleteAutoReply`.
- [ ] Hiển thị phạm vi/thời gian/kích hoạt đúng contract provider.
- [x] Phân biệt quick message native với mẫu trả lời nhanh ChatbotX.
- [x] Phân biệt auto-reply native với Flow/AI Agent; cảnh báo cấu hình có thể trả lời kép.

## P2 · 18. Dashboard và vận hành tài khoản

- [ ] Danh sách account có avatar, UID, connection/live status và thời điểm cập nhật.
- [ ] Lịch sử uptime/downtime và nguyên nhân chuyển trạng thái.
- [ ] Chỉ số gửi/nhận theo account, DM/nhóm, người dùng/automation.
- [ ] Chỉ số friend request, tra cứu, sync, upload/download và API errors.
- [ ] Hạn mức theo loại thao tác: burst/day, đã dùng, còn lại và cooldown.
- [ ] Không coi ngưỡng tự cấu hình là hạn mức chính thức do Zalo công bố.
- [ ] Theo dõi queue lag, DLQ, timeout, unknown send và lỗi lưu media.
- [ ] Hiển thị đồng bộ bạn bè/nhóm/nhãn/history: đang chạy, thành công, partial, lỗi.
- [ ] Cảnh báo mất kết nối, cần QR, reconnect lặp, storage lỗi và backlog tăng.
- [ ] Thao tác phục hồi có kết quả cụ thể; không báo thành công khi chỉ mới enqueue.
- [ ] Bộ lọc và thao tác nhiều account, trả kết quả riêng từng tài khoản.

## P3 · 19. Catalog, sản phẩm và capability chuyên biệt

- [ ] Catalog CRUD qua `getCatalogList`, `createCatalog`, `updateCatalog`, `deleteCatalog`.
- [ ] Product CRUD qua `getProductCatalogList`, `createProductCatalog`, `updateProductCatalog`, `deleteProductCatalog`.
- [ ] Upload ảnh sản phẩm qua `uploadProductPhoto`.
- [ ] Lưu ảnh sản phẩm trên R2/S3, mapping provider ID và version nếu có.
- [ ] Phân biệt catalog native Zalo với catalog ecommerce của ChatbotX.
- [ ] Kiểm chứng quyền business/package trước khi hiện thao tác.
- [ ] Report qua `sendReport` với loại đối tượng/lý do được SDK hỗ trợ.
- [ ] `custom` chỉ dùng như khả năng mở rộng nội bộ có kiểm soát; không mở endpoint gọi provider tùy ý.

## P0–P2 · 20. Dữ liệu cần lưu trong DB và R2/S3

- [ ] **DB:** account/thread/message identity, provider/client ID, timestamp và loại nội dung.
- [ ] **DB:** nội dung chuẩn hóa, quote, mentions, styles, album và metadata card.
- [ ] **DB:** quan hệ bạn bè, alias, profile và provenance theo account.
- [ ] **DB:** group/member/role/settings và mức đầy đủ của snapshot.
- [ ] **DB:** receipt/reaction/undo và lịch sử thay đổi cần tracking.
- [ ] **DB:** send-attempt, operation result, sync cursor/checkpoint và lỗi.
- [ ] **DB:** object key, checksum, MIME, size, dimensions/duration và trạng thái lưu media.
- [ ] **R2/S3:** ảnh/file/video/audio/GIF gửi và nhận, kể cả own-echo/history.
- [ ] **R2/S3:** original, thumbnail/poster và bản tối ưu.
- [ ] **R2/S3:** sticker assets, avatar/cover và ảnh sản phẩm khi sử dụng.
- [ ] **R2/S3:** export/archive hoặc fixture đã làm sạch khi có nhu cầu lưu dài hạn.
- [ ] Payload mẫu/raw phục vụ chẩn đoán có chọn lọc, version, giới hạn thời gian và quyền đọc.
- [ ] Cookie, IMEI, user-agent và authorization tiếp tục lưu mã hóa; không đưa vào object công khai/log.
- [ ] Cipher key chỉ dùng cho protocol trong gateway; không coi là dữ liệu nghiệp vụ cần xuất/lưu công khai.
- [ ] QR đăng nhập là dữ liệu ngắn hạn; không đưa vào kho media lưu vĩnh viễn.

## P0–P2 · 21. API, CLI/MCP, quyền và kiểm chứng

- [x] Public API cho các capability hiện có đã có nền tảng.
- [ ] Mỗi capability mới có public API, CLI/MCP và UI dùng chung business service.
- [ ] Capability matrix tách **receive / render / send / sync / admin** theo DM/nhóm và quyền tài khoản.
- [ ] Không trả `reactions: false` mơ hồ khi thực tế nhận được nhưng chưa gửi được.
- [ ] Kiểm kê đủ 146 phương thức: đã dùng, chưa dùng, nội bộ, không áp dụng hoặc chưa chứng minh hoạt động.
- [ ] Kiểm kê đủ event: `message`, `old_messages`, `seen_messages`, `delivered_messages`, `typing`, `reaction`, `old_reactions`, `undo`, `friend_event`, `group_event`.
- [ ] Xử lý lifecycle `connected/disconnected/closed/error`, upload completion `upload_attachment` và protocol event `cipher_key` đúng phạm vi.
- [ ] Kiểm tra scope workspace/account/inbox/group cho mọi API và event.
- [ ] Phân quyền riêng cho xem, gửi, quản trị nhóm, quản trị account và xem nội dung thu hồi.
- [ ] Audit thao tác native có tác động ngoài ChatbotX.
- [ ] Giữ guard owner/quota, policy epoch, template decision và workspace purge cho dữ liệu mới.
- [ ] Fixture thật đã làm sạch cho từng loại tin/event; kiểm tra sự khác biệt DM/nhóm/own-echo/history.
- [ ] Kiểm tra upload nhiều file, timeout, reconnect giữa chừng và kết quả gửi không xác định.
- [ ] Kiểm tra file được lưu trước/sau thu hồi, URL hết hạn và object storage thiếu.
- [ ] Kiểm tra event đến sai thứ tự, lặp, undo trước message, reaction sau undo.
- [ ] Kiểm tra UI desktop/mobile, file lỗi, media chưa tải xong và tài khoản mất kết nối.
- [ ] Chỉ đánh dấu hoàn thành khi **provider → chuẩn hóa → lưu DB/R2 → API → UI → kiểm chứng thật** đều hoạt động.
- [ ] Không coi sửa nội dung nội bộ CRM là sửa tin trên Zalo; SDK hiện tại chưa cung cấp khả năng edit tin thật đã được xác nhận.

## Nguồn đối chiếu

- [ChatbotX Zalo Account](./zalo-account.md).
- [Gateway package và phiên bản SDK](../apps/zalo-account-gateway/package.json).
- [Gateway adapter](../apps/zalo-account-gateway/src/runtime/zca-client.ts).
- [Gateway runtime](../apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts).
- [Chuẩn hóa tin nhắn](../apps/zalo-account-gateway/src/runtime/provider-message.ts).
- [Public API](../apps/builder/src/features/zalo-accounts/api/public.ts) và [operations](../apps/builder/src/features/zalo-accounts/api/operations.ts).
- [Canonical send và lưu media gửi](../packages/business/src/zalo-account/canonical-send.service.ts).
- [Message lifecycle và thu hồi](../packages/business/src/zalo-account/message-lifecycle.service.ts).
- [Media resolver](../packages/business/src/media/resolve-media-url.ts).
- API SDK đã đối chiếu trong checkout local: `apps/zalo-account-gateway/node_modules/zca-js/dist/apis.d.ts`; listener tại `dist/apis/listen.d.ts`, profile/group/event tại `dist/models/`. Các file này thuộc dependency sau khi cài đặt, không phải source được commit trong repo.
- [Upstream zca-js](https://github.com/RFS-ADRENO/zca-js); khi triển khai đối chiếu đúng phiên bản đã pin trong gateway.

Repo tham khảo local: `/Volumes/DevSSD/Work/GitHub/ZaloCRM`. Các đường dẫn bên dưới tính từ root repo tham khảo, không phải dependency của ChatbotX:

- `backend/src/shared/zalo-operations.ts`: wrapper API, send, reaction, friend/group và thao tác native.
- `backend/src/modules/zalo/zalo-listener-factory.ts`: listener, message/event và socket lifecycle.
- `backend/src/modules/contacts/zinstant-proxy-routes.ts`: sticker metadata và tìm kiếm.
- `frontend/src/components/chat/message-bubble.vue` và `StickerPicker.vue`: render/picker sticker.
- `backend/src/modules/chat/message-handler.ts`: inbound media mirror.
- `backend/src/modules/zalo/zalo-history-backfill.ts`: history pump DM/nhóm.
- `backend/src/modules/contacts/zalo-profile-capture.ts`: chuẩn hóa và lưu profile.
- `backend/src/modules/zalo/presence-service.ts`: presence, cache và last online.
- `backend/src/modules/zalo/group-routes.ts` và `group-moderation-routes.ts`: quản trị nhóm.
- `backend/src/modules/zalo/nick-metrics-service.ts` và `frontend/src/composables/use-zalo-accounts-dashboard.ts`: chỉ số, trạng thái live và dashboard account.
