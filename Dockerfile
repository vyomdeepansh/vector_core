# ==========================================
# STAGE 1: Compilation Environment
# ==========================================
FROM python:3.11-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Download and compile Tailwind during the build stage
RUN curl -sLO https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-linux-x64 && \
    chmod +x tailwindcss-linux-x64 && \
    mv tailwindcss-linux-x64 /usr/local/bin/tailwindcss

# Copy source assets for compilation
COPY static/ ./static
COPY tailwind.config.js .

# Compile optimized CSS
RUN tailwindcss -i ./static/css/src.css -o ./static/css/theme.css --minify

# Download verified D3 package
RUN curl -sL https://d3js.org/d3.v7.min.js -o ./static/js/d3.v7.min.js

# ==========================================
# STAGE 2: Secure Production Runner
# ==========================================
FROM python:3.11-slim AS runner

WORKDIR /app

RUN groupadd -g 10001 appgroup && \
    useradd -u 10001 -g appgroup -m -s /bin/bash appuser

COPY --from=builder /root/.local /home/appuser/.local
COPY --from=builder /usr/lib /usr/lib
# Copy compiled, self-contained assets from builder
COPY --from=builder --chown=appuser:appgroup /build/static ./static

ENV PATH=/home/appuser/.local/bin:$PATH
ENV PYTHONUNBUFFERED=1

COPY --chown=appuser:appgroup app/ ./app

USER 10001

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
