FROM python:3.12-slim

WORKDIR /app

# Without this, `docker logs` shows nothing until the buffer fills, which hid a
# month of failed fetches behind an empty log.
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p data

CMD ["sh", "-c", "python manage.py migrate --run-syncdb && python manage.py runserver 0.0.0.0:8000"]
