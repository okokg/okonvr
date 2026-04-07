#!/bin/bash
echo "[detect] Checking Coral TPU..."
python3 -c "
from pycoral.utils.edgetpu import list_edge_tpus
tpus = list_edge_tpus()
print(f'[detect] Found {len(tpus)} TPU(s): {tpus}')
if not tpus:
    print('[detect] No TPU found, waiting for USB...')
    exit(1)
" 2>/dev/null

if [ $? -ne 0 ]; then
    echo "[detect] No TPU, waiting 5s..."
    sleep 5
    exit 1
fi

echo "[detect] Starting detector..."
exec python3 /app/detector.py
