FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm ci --workspace @docflow/shared --workspace @docflow/core \
    --workspace @docflow/api --workspace @docflow/worker --include-workspace-root

COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

ARG APP
ENV APP=${APP}

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps apps

USER node
CMD ["sh", "-c", "exec node apps/${APP}/dist/main.js"]
