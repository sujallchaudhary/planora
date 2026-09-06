# Debian-based image: onnxruntime-node (local embeddings) ships glibc binaries, not musl.
# Build with --build-arg WITH_LOCAL_EMBEDDINGS=true to include the Transformers.js stack (~300 MB).
FROM node:22-slim AS builder
ARG WITH_LOCAL_EMBEDDINGS=false
WORKDIR /app
COPY package*.json ./
RUN if [ "$WITH_LOCAL_EMBEDDINGS" = "true" ]; then npm ci; else npm ci --omit=optional; fi
COPY . .
RUN npm run build \
 && if [ "$WITH_LOCAL_EMBEDDINGS" = "true" ]; then npm prune --omit=dev; else npm prune --omit=dev --omit=optional; fi

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE_DIR=/app/.cache/transformers
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/.cache/transformers
VOLUME ["/app/.cache"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
