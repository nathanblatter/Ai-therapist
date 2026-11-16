# Phase 2 analysis (ai-therapist-108). Plain Python, no cloud, not part of the Node CI gates.
#
#   make setup     create .venv and install the pinned requirements
#   make test      run the pytest suite (synthetic data only)
#   make synthetic write a synthetic export and run the full analysis on it
#   make power     re-run the full power simulation (about 30 CPU-minutes)
#   make all       test + synthetic
#
# Real data:  .venv/bin/python -m phase2.analyze --data <unzipped export dir> --out <output dir>

PY ?= .venv/bin/python
SEED ?= 20261116

.PHONY: setup test synthetic power power-quick all clean

setup:
	python3 -m venv .venv
	.venv/bin/pip install --quiet -r requirements.txt

test:
	$(PY) -m pytest tests -q

synthetic:
	rm -rf build/synthetic-export
	$(PY) -m phase2.synth --out build/synthetic-export --seed $(SEED)
	$(PY) -m phase2.analyze --data build/synthetic-export --out results/synthetic-run > /dev/null
	@echo "wrote results/synthetic-run/report.md and estimates.csv (SYNTHETIC)"

power:
	$(PY) -m phase2.power

power-quick:
	$(PY) -m phase2.power --reps 40 --out build/power-quick

all: test synthetic

clean:
	rm -rf build .pytest_cache
