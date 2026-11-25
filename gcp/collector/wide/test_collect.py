import unittest
from types import SimpleNamespace
from collect import Venue, chains, ccxt, mode_for, now_ms


class CoverageTests(unittest.TestCase):
    def test_currency_network_must_publish_its_own_chain_and_contract(self):
        ca = "0x" + "ab" * 20
        self.assertEqual(chains({"networks": {"ETH": {"info": "ERC20"}, "BSC": {"info": []}}}), [])
        self.assertEqual(chains({"networks": {"BSC": {"info": {"contractAddress": ca}}}}), [[56, ca]])

    def test_existing_native_books_and_inverse_contracts(self):
        m = {"spot": True, "quote": "USDT"}
        self.assertIsNone(mode_for("bitget", m))
        self.assertEqual(mode_for("binance", m), "spot")
        self.assertEqual(mode_for("binancecoinm", {"swap": True, "inverse": True, "quote": "USD"}), "inverse")

    def test_single_trade_requires_a_fresh_trade_time(self):
        ex = SimpleNamespace(markets={"A/USD": {"id": "A_USD", "base": "A", "quote": "USD",
                             "precision": {"amount": 0}}}, last_response_headers={}, precisionMode=ccxt.DECIMAL_PLACES)
        v = Venue(ex)
        def parse(ticker):
            return v.parse("spot",["A/USD"],{"A/USD":ticker})
        self.assertEqual(parse({"last":1}), {})
        self.assertEqual(parse({"last":1,"timestamp":now_ms()-46000}), {})
        row = parse({"last":1,"timestamp":now_ms()})["A/USD"]
        self.assertIsNone(row[4])
        self.assertIsNone(row[5])
        self.assertEqual(row[8],1)
        self.assertEqual(row[10],1)


if __name__ == "__main__":
    unittest.main()
