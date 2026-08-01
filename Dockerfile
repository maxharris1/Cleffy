# Production image: build the static SPA, serve it with nginx.
# The app is fully static — all state lives in Supabase — so this container
# has no runtime dependencies beyond a web server.
#
#   docker compose up --build          → http://localhost:5173
#
# Vite bakes env vars at BUILD time; pass them as build args (compose wires
# them from .env automatically).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
