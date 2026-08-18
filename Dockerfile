
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY lab/package.json lab/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir /data \
  && chown nextjs:nodejs /data
COPY --from=build --chown=nextjs:nodejs /app/lab/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/lab/.next/static ./lab/.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "lab/server.js"]
