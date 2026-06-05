FROM node:24-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @roamcli/protocol build \
  && pnpm --filter @roamcli/security build \
  && pnpm --filter @roamcli/parser-sdk build \
  && pnpm --filter @roamcli/web build \
  && pnpm --filter @roamcli/server build

FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV ROAMCLI_DATA_DIR=/data
ENV ROAMCLI_WEB_DIST=/app/apps/web/dist

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "apps/server/dist/index.js"]
