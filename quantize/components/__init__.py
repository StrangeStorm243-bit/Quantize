"""Compositional component resolution (M3): catalog, closure fetching, and instantiation.

Components are evaluated compositionally — never flattened, no stub expansion. This package
resolves a strategy's pinned ``ComponentRef``s into real ``ComponentDefinition``s, rejects direct
and transitive recursion over the fetched closure, checks exposed port mappings and parameter
bindings, and produces the instance tree the evaluator walks.
"""
