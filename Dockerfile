FROM oven/bun:1.4.3-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bun runs TypeScript directly: no build step, tsconfig drives decorator metadata.
COPY tsconfig.json bunfig.toml ./
COPY src ./src

USER bun
EXPOSE 3000

# Exec form: bun is PID 1 and receives SIGTERM, which triggers Nest shutdown hooks.
CMD ["bun", "run", "src/main.ts"]
