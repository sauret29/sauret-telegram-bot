name: Backtest Gann Lookback

on:
  workflow_dispatch: # permite ejecutarlo manualmente desde la pestaña "Actions"

jobs:
  backtest:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Ejecutar backtest
        run: node backtest_gann_lookback.js | tee backtest_results.txt

      - name: Guardar resultados como artifact
        uses: actions/upload-artifact@v4
        with:
          name: backtest-results
          path: backtest_results.txt

      - name: Mostrar resumen en el resumen del job
        run: cat backtest_results.txt >> $GITHUB_STEP_SUMMARY
