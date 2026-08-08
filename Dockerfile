FROM nginxinc/nginx-unprivileged:1.29-alpine-slim
COPY --chown=101:101 demo/ /usr/share/nginx/html/
COPY --chown=101:101 deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
