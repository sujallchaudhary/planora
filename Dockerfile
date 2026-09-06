# Debian-based image: onnxruntime-node (local embeddings) ships glibc binaries, not musl.
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE_DIR=/app/.cache/transformers
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/.cache/transformers
COPY --from=builder /app/dist ./dist
VOLUME ["/app/.cache"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
