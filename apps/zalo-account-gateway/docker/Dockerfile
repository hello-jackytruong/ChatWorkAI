FROM node:24.22.3-trixie-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
FROM base AS pre
RUN npm install -g turbo@^2
COPY . .
RUN turbo prune zalo-account-gateway --docker
FROM base AS deps
COPY --from=pre /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pre /app/out/full/ .
RUN SKIP_ENV_CHECK=true pnpm turbo run build --filter=zalo-account-gateway
# Keep the pruned dependency tree: zca-js and native transitive dependencies
# must resolve from the bundle just as they do in the source workspace.
FROM base AS release
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app /app
USER node
WORKDIR /app/apps/zalo-account-gateway
# Workspace package exports point at TypeScript, as in the realtime image.
# tsx resolves these exports without Node's unsupported TS syntax limitations.
CMD ["node", "--import", "tsx", "--enable-source-maps", "dist/main.mjs"]
EXPOSE 3211
