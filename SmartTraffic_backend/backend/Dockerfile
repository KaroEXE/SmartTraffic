# syntax=docker/dockerfile:1
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Install production dependencies first so this layer is cached between builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy only the app folders. .env and test/ are deliberately left out so local
# secrets never end up inside the image. Secrets are set in Northflank instead.
COPY server.js ./
COPY config ./config
COPY controllers ./controllers
COPY db ./db
COPY docs ./docs
COPY models ./models
COPY repositories ./repositories
COPY routes ./routes
COPY scripts ./scripts
COPY services ./services
COPY socket ./socket
COPY utils ./utils

# The official image ships a non-root "node" user; run as that user.
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "server.js"]
