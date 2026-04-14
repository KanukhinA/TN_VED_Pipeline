# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS builder

WORKDIR /app
ARG VITE_UI_MODE=expert
ENV VITE_UI_MODE=$VITE_UI_MODE
COPY frontend/package.json /app/package.json
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --fund=false

COPY frontend /app
RUN npm run build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
