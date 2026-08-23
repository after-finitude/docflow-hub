FROM node:24-alpine AS build
WORKDIR /app

ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=${API_INTERNAL_URL}

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @docflow/shared --workspace @docflow/web --include-workspace-root

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @docflow/shared && npm run build -w @docflow/web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
RUN mkdir -p apps/web/.next/cache && chown -R node:node apps/web/.next

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
