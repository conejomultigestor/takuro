FROM python:3.13-slim
WORKDIR /app
COPY relay.py .
EXPOSE 10000
CMD ["python", "relay.py"]