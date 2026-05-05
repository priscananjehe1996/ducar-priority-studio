# Implementation Notes

The source logic mirrors the workbook:

1. Classify maintainability and referral status.
2. Calculate priority score using road or bridge weights.
3. Sort by score descending.
4. Select eligible items while cumulative cost fits within the budget.
5. Report selected, deferred, referred and exception items separately.
