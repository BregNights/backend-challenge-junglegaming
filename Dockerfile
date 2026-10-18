FROM oven/bun:1.4.3-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# O Bun executa TypeScript direto: sem etapa de build; o tsconfig controla os metadados dos decorators.
COPY tsconfig.json bunfig.toml ./
COPY src ./src

USER bun
EXPOSE 3000

# Forma exec: o bun é o PID 1 e recebe o SIGTERM, que dispara os shutdown hooks do Nest.
CMD ["bun", "run", "src/main.ts"]
