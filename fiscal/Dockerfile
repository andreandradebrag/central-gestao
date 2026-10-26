# imagem com versão fixa (troque de propósito, depois de testar; nunca use etiqueta móvel como "3.12-slim")
FROM python:3.13.16-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py test_app.py ./
# os testes rodam no build: se a assinatura ou a leitura dos XMLs quebrar, a imagem não é criada
RUN DATA_DIR=/tmp/t python -m unittest -q test_app.py && rm -rf /tmp/t
ENV PYTHONUNBUFFERED=1 PORT=8000 DATA_DIR=/data CERT_PATH=/certs/certificado.pfx
RUN useradd -r -u 10001 fiscal && mkdir -p /data /certs && chown fiscal /data
USER fiscal
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/saude')" || exit 1
CMD ["python", "app.py"]
