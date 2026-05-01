FROM node:24-slim AS builder

WORKDIR /app
ARG VITE_UI_MODE=expert
ARG VITE_API_BASE=/api
ENV VITE_UI_MODE=$VITE_UI_MODE
ENV VITE_API_BASE=$VITE_API_BASE
COPY frontend/package.json /app/package.json
RUN npm install --no-audit --fund=false

COPY frontend /app
RUN npm run build

FROM node:24-slim
WORKDIR /app
RUN npm install -g serve
COPY --from=builder /app/dist /app/dist

EXPOSE 80
CMD ["serve", "-s", "dist", "-l", "80"]
