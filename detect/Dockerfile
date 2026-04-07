FROM debian:11-slim

RUN echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99no-check-valid && \
    echo 'Acquire::Check-Date "false";' >> /etc/apt/apt.conf.d/99no-check-valid && \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends \
    python3 python3-pip \
    curl gnupg ca-certificates \
    libusb-1.0-0 usbutils \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Coral Edge TPU runtime
RUN echo "deb https://packages.cloud.google.com/apt coral-edgetpu-stable main" \
      > /etc/apt/sources.list.d/coral-edgetpu.list && \
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key add - && \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends libedgetpu1-std && \
    rm -rf /var/lib/apt/lists/*

# Python deps — numpy<2 MUST be in same pip call as opencv (otherwise opencv pulls numpy 2.x)
RUN pip3 install --no-cache-dir "numpy<2" Pillow opencv-python-headless
RUN pip3 install --no-cache-dir tflite-runtime || \
    echo "WARN: tflite-runtime pip failed, trying pycoral repo..."
RUN pip3 install --no-cache-dir \
      --extra-index-url https://google-coral.github.io/py-repo/ \
      pycoral~=2.0 || \
    (apt-get -o Acquire::Check-Valid-Until=false update && \
     apt-get install -y --no-install-recommends python3-pycoral && \
     rm -rf /var/lib/apt/lists/*) || \
    echo "WARN: pycoral install failed (non-critical)"

WORKDIR /app
COPY detector.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3001
CMD ["/app/entrypoint.sh"]
