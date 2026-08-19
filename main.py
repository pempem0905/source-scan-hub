import json
print(">>> PROMO_MASTER da khoi dong")
data = {"status": "ok"}
with open('deals.json', 'w') as f:
    json.dump(data, f)
print(">>> Da tao file deals.json")
