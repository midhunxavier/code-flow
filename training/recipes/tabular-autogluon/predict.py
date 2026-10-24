"""Load a trusted Code Flow export in a separate process."""
from pathlib import Path
import sys
import pandas as pd
from autogluon.tabular import TabularPredictor

root = Path(__file__).resolve().parent
model = TabularPredictor.load(str(root / 'model'))
inputs = pd.read_csv(sys.argv[1])
model.predict(inputs).to_csv(sys.argv[2], index=False, header=['prediction'])
