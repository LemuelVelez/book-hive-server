# syntax=docker/dockerfile:1

############################
# 1) Build stage
############################
FROM node:20-alpine AS build
WORKDIR /app

# Install deps (avoid running postinstall during install)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source
COPY tsconfig.json ./
COPY database.json ./
COPY src ./src
COPY migrations ./migrations

# Build TypeScript -> dist
RUN npm run build


############################
# 2) Runtime stage
############################
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install prod deps only (avoid postinstall)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built app + runtime files
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/database.json ./database.json

# Run as non-root
USER node

# Coolify will map this, but it's good documentation
EXPOSE 5000

# Optional: run migrations on startup if RUN_MIGRATIONS=true
CMD ["sh", "-c", "if [ \"${RUN_MIGRATIONS:-false}\" = \"true\" ]; then npm run migrate:prod; fi; node dist/index.js"]