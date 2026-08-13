FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN python3 -m piper.download_voices --download-dir /app/voices en_US-joe-medium

COPY app.py .

EXPOSE 5000

CMD ["gunicorn", "-w", "1", "--threads", "2", "-b", "0.0.0.0:5000", "--timeout", "300", "app:app"]
