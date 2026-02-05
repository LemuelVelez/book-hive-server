# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS base
WORKDIR /app

# Install all deps (including dev) for build
FROM base AS deps
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --ignore-scripts; \
    else \
      npm install --ignore-scripts; \
    fi

# Build TypeScript -> dist
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Install production-only deps
FROM base AS prod-deps
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts; \
    else \
      npm install --omit=dev --ignore-scripts; \
    fi && npm cache clean --force

# Final runtime image
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist

EXPOSE 5000
CMD ["node", "dist/index.js"]
