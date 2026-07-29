# Operations

## Restart service

```bash
sudo systemctl restart product-eval-catalog.service
sudo systemctl status product-eval-catalog.service --no-pager
```

## Logs

```bash
journalctl -u product-eval-catalog.service --since "30 minutes ago" --no-pager
```

## Production DB changes

Follow the controlled sequence:

1. Notify
2. Stop `product-eval-catalog.service`
3. Backup `ocp_catalog_eval`
4. Apply DB change in one transaction with explicit quality gates
5. Verify with `eval_reader`
6. Restart service
7. Observe logs and public endpoints

Do not run DDL/high-risk DML while the query service is serving traffic.
