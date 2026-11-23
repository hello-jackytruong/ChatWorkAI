# Checklist link chatbotx.io còn lại

Ngày kiểm tra: 2026-11-23. Phạm vi: file được Git theo dõi trong checkout này; không đọc dotenv riêng, không truy cập dữ liệu production và không kiểm tra HTTP của dịch vụ bên ngoài. `plans/` là lịch sử công việc nên không đưa vào thống kê. Namespace `@chatbotx.io/*` là package, không được tính là URL.

Có **35 địa chỉ khác nhau**, tại **30 file**. Tất cả giữ nguyên để chờ quyết định. Một địa chỉ có thể nằm trong nhiều nhóm.

## Các nhóm cần quyết định trước

| Nhóm | Ví dụ | Cần xác định |
| --- | --- | --- |
| Pháp lý | `https://chatbotx.io/privacy/`, `https://chatbotx.io/terms/` | URL chính sách và điều khoản ChatWorkAI |
| API / MCP mặc định | `https://app.chatbotx.io/api` | Host thật của bản triển khai, không suy đoán tên miền mới |
| Tài liệu / hỗ trợ | `https://chatbotx.io/docs`, `https://discord.chatbotx.io/` | Nơi hỗ trợ và tài liệu mới |
| Email | địa chỉ `@chatbotx.io` | Hộp thư mới có nhận được thư hay không |
| Upstream / cấp phép | các địa chỉ trong LICENSE hoặc tài liệu upstream | Giữ nguồn gốc và quyền sở hữu hiện có |

## Định danh giữ nguyên để tương thích

- Package `@chatbotx.io/*`, lệnh `chatbotx`, package `chatbotx-mcp`, biến `CHATBOTX_*`, key dịch, cookie, database enum, schema, metadata và header webhook được giữ nguyên.
- `partner_agent: "ChatbotX"` và User-Agent là định danh tích hợp kỹ thuật, không phải nhãn giao diện.
- Giấy phép, copyright, lịch sử kế hoạch và chú thích kỹ thuật không bị đổi tên hàng loạt.
- Cài đặt white-label, menu/email đã lưu, workspace demo đã tạo và help links trong database không được cập nhật tự động. Tên mặc định và dữ liệu tạo mới dùng ChatWorkAI. Menu webchat Community được chuẩn hoá thành nhãn mới khi đi qua luồng cập nhật hiện có; vẫn nhận diện nhãn cũ để không nhân đôi menu. Cần kiểm tra các dữ liệu đang chạy khác riêng.
- Logo ứng dụng đã dùng ChatWorkAI. README đã trỏ tới logo mới; ảnh chụp/video hướng dẫn và ảnh hero lịch sử chưa được thiết kế lại.

## Runtime / product (6 địa chỉ)

| Đã quyết định | Địa chỉ giữ nguyên | Vị trí |
| --- | --- | --- |
| [ ] | `chatbotx.io` (chỉ nhận diện menu đã lưu với nhãn thương hiệu cũ, không phải URL gọi ra ngoài) | `packages/business/src/integration-webchat/branding.ts:37` |
| [ ] | `https://app.chatbotx.io/api` | `apps/mcp-server/src/env.ts:22` |
| [ ] | `https://chatbotx.io/api/licenses/refresh` | `packages/business/src/keys.ts:15` |
| [ ] | `https://chatbotx.io/licenses` | `packages/business/src/enterprise/license/public-keys.ts:1` |
| [ ] | `https://chatbotx.io/privacy/` | `apps/builder/src/features/auth/sign-in.tsx:133`<br>`apps/builder/src/features/auth/sign-up.tsx:103`<br>`packages/business/src/platform/settings.ts:58` |
| [ ] | `https://chatbotx.io/terms/` | `apps/builder/src/enterprise/LICENSE:9`<br>`apps/builder/src/features/auth/sign-in.tsx:134`<br>`apps/builder/src/features/auth/sign-up.tsx:104`<br>`packages/business/src/platform/settings.ts:59`<br>`packages/database/src/schema/enterprise/LICENSE:9` |

## Configuration / assets / scripts (6 địa chỉ)

| Đã quyết định | Địa chỉ giữ nguyên | Vị trí |
| --- | --- | --- |
| [ ] | `app.chatbotx.io/mcp` | `apps/mcp-server/.env.example:1` |
| [ ] | `https://app.chatbotx.io` | `apps/mcp-server/.env.example:17`<br>`apps/mcp-server/.env.example:19` |
| [ ] | `https://app.chatbotx.io/api` | `apps/mcp-server/.env.example:4` |
| [ ] | `https://app.chatbotx.io/mcp` | `.env.example:310` |
| [ ] | `https://chatbotx.io/api/licenses/refresh` | `.env.example:14` |
| [ ] | `https://chatbotx.io/docs` | `.github/ISSUE_TEMPLATE/config.yml:5` |

## Documentation (18 địa chỉ)

| Đã quyết định | Địa chỉ giữ nguyên | Vị trí |
| --- | --- | --- |
| [ ] | `https://app.chatbotx.io` | `README.md:73`<br>`docs/mcp-oauth.md:23` |
| [ ] | `https://app.chatbotx.io/api` | `apps/cli/README.md:32`<br>`apps/cli/README.md:38`<br>`apps/cli/README.md:45`<br>`apps/mcp-server/README.md:9`<br>`apps/mcp-server/README.md:342` |
| [ ] | `https://app.chatbotx.io/mcp/messages` | `apps/mcp-server/README.md:15`<br>`apps/mcp-server/README.md:221`<br>`apps/mcp-server/README.md:230` |
| [ ] | `https://app.chatbotx.io/mcp/sse` | `apps/mcp-server/README.md:16`<br>`apps/mcp-server/README.md:236` |
| [ ] | `https://chatbotx.io/` | `README.md:27` |
| [ ] | `https://chatbotx.io/api/licenses/refresh` | `docs/licensing.md:67` |
| [ ] | `https://chatbotx.io/docs` | `README.md:31` |
| [ ] | `https://chatbotx.io/docs/api-reference/api-overview` | `README.md:79` |
| [ ] | `https://chatbotx.io/docs/cli/introduction` | `README.md:75` |
| [ ] | `https://chatbotx.io/docs/howitworks` | `CONTRIBUTING.md:7` |
| [ ] | `https://chatbotx.io/docs/integrations/make` | `README.md:85` |
| [ ] | `https://chatbotx.io/docs/integrations/n8n` | `README.md:83` |
| [ ] | `https://chatbotx.io/docs/mcp/introduction` | `README.md:77` |
| [ ] | `https://chatbotx.io/docs/quickstart` | `README.md:147` |
| [ ] | `https://chatbotx.io/licenses` | `docs/licensing.md:105` |
| [ ] | `https://chatbotx.io/lifetime/?ref=github` | `README.md:17` |
| [ ] | `https://discord.chatbotx.io` | `CONTRIBUTING.md:15`<br>`CONTRIBUTING.md:72` |
| [ ] | `https://discord.chatbotx.io/` | `README.md:33` |

## Tests / fixtures (17 địa chỉ)

| Đã quyết định | Địa chỉ giữ nguyên | Vị trí |
| --- | --- | --- |
| [ ] | `app.chatbotx.io` | `apps/builder/__tests__/webchat-page-guards.test.tsx:134` |
| [ ] | `chatbotx.io` | `packages/business/__tests__/integration-webchat-service.test.ts:548` |
| [ ] | `http://app.chatbotx.io` | `packages/business/__tests__/tenant-settings-domain.test.ts:174`<br>`packages/business/__tests__/tenant-settings-domain.test.ts:277` |
| [ ] | `http://files.chatbotx.io/assets` | `packages/business/__tests__/tenant-settings-domain.test.ts:175` |
| [ ] | `https://app.chatbotx.io` | `apps/builder/__tests__/mcp-oauth-connect-snippets.test.ts:7`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:10`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:12`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:17`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:31`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:38`<br>`apps/builder/__tests__/update-webchat-action-permission.test.ts:16`<br>`apps/builder/__tests__/webchat-page-guards.test.tsx:53`<br>`apps/builder/__tests__/whatsapp-connect-webhook-url.test.ts:18`<br>`packages/business/__tests__/appointment-inbox-booking-link.test.ts:46`<br>`packages/business/__tests__/tenant-settings-domain.test.ts:3`<br>`packages/business/__tests__/tenant-settings-domain.test.ts:10`<br>`packages/business/__tests__/tenant-settings-entitlement.test.ts:3`<br>`packages/business/__tests__/tenant-settings-entitlement.test.ts:7` |
| [ ] | `https://app.chatbotx.io/?ref=selfhosted&channel=webchat` | `apps/builder/__tests__/webchat-page-guards.test.tsx:358`<br>`apps/builder/__tests__/webchat-page-guards.test.tsx:365`<br>`packages/business/__tests__/branding-menu.test.ts:7` |
| [ ] | `https://app.chatbotx.io/api` | `apps/builder/__tests__/mcp-oauth-connect-snippets.test.ts:34` |
| [ ] | `https://app.chatbotx.io/mcp` | `apps/builder/__tests__/mcp-oauth-connect-snippets.test.ts:8`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:33`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:55`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:64`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:69` |
| [ ] | `https://app.chatbotx.io/mcp/` | `apps/builder/__tests__/oauth-protected-resource-route.test.ts:50`<br>`apps/builder/__tests__/oauth-protected-resource-route.test.ts:67` |
| [ ] | `https://app.chatbotx.io/mcp/messages` | `apps/builder/__tests__/mcp-oauth-connect-snippets.test.ts:11`<br>`apps/builder/__tests__/mcp-oauth-connect-snippets.test.ts:14` |
| [ ] | `https://app.chatbotx.io/mcp/sse` | `apps/builder/__tests__/mcp-oauth-connect-snippets.test.ts:12` |
| [ ] | `https://app.chatbotx.io/some/path` | `apps/builder/__tests__/webchat-page-guards.test.tsx:189` |
| [ ] | `https://app.chatbotx.io/space/0b6c2f5e-6a3e-4c55-9d0f-3f1f4f2a9e11/settings/channels?channel=tiktok` | `apps/builder/__tests__/oauth-state-decode.test.ts:9` |
| [ ] | `https://app.chatbotx.io/webchat?workspaceId=1&webchatId=2` | `apps/builder/__tests__/webchat-page-guards.test.tsx:201`<br>`apps/builder/__tests__/webchat-page-guards.test.tsx:232` |
| [ ] | `https://files.chatbotx.io/assets` | `packages/business/__tests__/tenant-settings-domain.test.ts:5` |
| [ ] | `https://files.chatbotx.io/assets/` | `packages/business/__tests__/tenant-settings-domain.test.ts:183` |
| [ ] | `https://mcp.chatbotx.io/mcp` | `apps/builder/__tests__/oauth-protected-resource-route.test.ts:44` |

## Agent instructions (2 địa chỉ)

| Đã quyết định | Địa chỉ giữ nguyên | Vị trí |
| --- | --- | --- |
| [ ] | `chatbotx.io/docs` | `AGENTS.md:193` |
| [ ] | `https://chatbotx.io/docs` | `AGENTS.md:193` |

## Email thuộc tên miền cũ

| Đã quyết định | Email | Vị trí |
| --- | --- | --- |
| [ ] | `admin@chatbotx.io` | `packages/business/__tests__/has-workspace-access.test.ts:22`<br>`packages/business/__tests__/resolve-workspace-access.test.ts:23`<br>`packages/business/__tests__/workspace-member-synthetic.test.ts:19` |
| [ ] | `email@chatbotx.io` | `apps/builder/src/features/contacts/create-contact-form.tsx:214` |
| [ ] | `security@chatbotx.io` | `CODE_OF_CONDUCT.md:63`<br>`CONTRIBUTING.md:74`<br>`SECURITY.md:14`<br>`apps/builder/src/enterprise/LICENSE:37`<br>`packages/database/src/schema/enterprise/LICENSE:37` |
| [ ] | `support@chatbotx.io` | `apps/builder/src/app/delete-account/page.tsx:11` |

## Kiểm tra thay đổi

- 53 file được chỉnh sửa; 21 locale không còn tên thương hiệu cũ trong giá trị hiển thị. Key dịch giữ nguyên.
- So sánh URL HTTP(S) trước/sau trong toàn bộ diff: không có URL nào thay đổi.
- `pnpm lint`: đạt, gồm i18n, schema drift và invariant checks.
- Typecheck 8 workspace bị ảnh hưởng: đạt; builder/business cũng đã đạt khi chạy lại sau thay đổi tương thích menu cuối cùng.
- 221 test đạt trong 16 file: business/tenant/webchat, builder webchat, MCP, Stripe và CLI.
- Invariant reviewer: PASS, bao gồm thay đổi nhận diện menu cũ.
- Không chạy full build, toàn bộ test monorepo, đo coverage hoặc kiểm tra trình duyệt. Không deploy, không đổi dữ liệu production.
