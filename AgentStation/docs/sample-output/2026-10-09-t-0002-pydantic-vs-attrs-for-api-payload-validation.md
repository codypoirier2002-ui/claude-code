---
task: T-0002
title: "pydantic vs attrs for API payload validation"
approved_at: 2026-10-09T22:11:46.781Z
review_verdict: pass
sources: 3
---

# pydantic vs attrs for API payload validation

## Summary and recommendation

**Recommendation (interpretation): use Pydantic for validating API payloads.** Pydantic describes itself as a data validation library built on Python type hints [S2], and its README example shows string input being validated and coerced into typed fields when a model is created [S2]. attrs describes itself as a tool for writing classes without boilerplate [S1][S3], so its stated purpose is class definition, not payload validation [S3].

Evidence limits (gap statement, see open questions): no Pydantic package metadata or attrs validation documentation was fetched. The recommendation rests on each library's stated purpose and one README example, not on a feature-by-feature comparison [S2][S3].

## What each library is for

**Facts**
- attrs describes itself as a package that relieves the developer from the drudgery of implementing object protocols (dunder methods) [S3]. PyPI lists its summary as "Classes Without Boilerplate" [S1].
- Pydantic describes itself as "Data validation using Python type hints." [S2]
- Types are entirely optional in attrs. Attributes can be declared with `attrs.field()` and no annotations [S3].
- Pydantic's README says V2 is a ground-up rewrite with breaking changes compared to V1, and that V2 bundles V1 for incremental migration [S2].

**Interpretation:** the two libraries have different primary jobs. Pydantic is aimed at validating data, and attrs at defining classes [S2][S3]. Teams adopting Pydantic should be aware of the V1/V2 split when reading older examples or planning upgrades [S2].

## Runtime validation support

**Facts**
- Pydantic: in the README example, a model is built from external data with string values for typed fields. The printed result is `User id=123 name='John Doe' signup_ts=datetime.datetime(2017, 6, 1, 12, 22) friends=[1, 2, 3]`, so the values were coerced to the declared types [S2].
- attrs: it ships a validators module, `attrs.validators` [S1]. Its changelog mentions fixes to `attrs.validators.optional()`, so validators are a supported feature [S1]. An `attrs.validators.disabled()` context manager exists and can now be nested [S1].

**Interpretation (inferred, not stated in the sources):**
- Pydantic validation appears to be built in, because it happens when a model is instantiated [S2].
- attrs validation appears to be opt-in, but this inference is weak. The existence of a validators module that can be disabled [S1] and optional types [S3] do not show how validators are attached, because no attrs documentation on that was fetched.

## Supported Python versions, licence and latest release

| | attrs | Pydantic |
|---|---|---|
| Purpose | Classes without boilerplate [S1][S3] | Data validation using Python type hints [S2] |
| Requires Python | >=3.9 [S1] | Not found in package metadata. The README prose says types are defined in "Python 3.10+" [S2], which hints at a minimum version but does not confirm it. |
| Licence | MIT [S1] | Not found in the fetched sources |
| Latest release | 26.1.0, uploaded 2026-03-19 (as retrieved from PyPI) [S1] | Not found in the fetched sources |

## Recommendation for validating API payloads

**Interpretation, based on the facts above:**
- Pydantic's stated purpose is data validation, and its README example shows external data being validated and coerced into typed fields at instantiation [S2]. That matches the payload-validation job directly.
- attrs offers validators [S1] but describes itself as a class-definition tool [S1][S3]. Using it for payloads would mean attaching validators to fields yourself, and the fetched sources do not show how [S1].
- **Uncertainty:** this is a judgement from purpose statements and one example [S2][S3]. It is not based on benchmarks, Pydantic validation documentation, or an ecosystem comparison.
- If the team already uses attrs for its data classes, the sources neither support nor rule out extending it to payload validation [S1][S3].

## Open questions and evidence gaps

- **Pydantic package metadata:** the latest release version and date, the Requires-Python value and the licence are not stated in the fetched sources. The fetched README content does not state these values [S2]. The Python 3.10+ figure comes from prose only [S2].
- **attrs validation documentation:** no attrs page on validators was fetched. How validators are attached, whether attrs converts types and how errors are reported are not covered. Whether validation is opt-in is inferred, not stated [S1][S3].
- **Pydantic validation features:** no documentation was fetched on whether validation is always on, strict mode, JSON parsing or error reporting. Only the README example shows coercion on instantiation [S2].
- **Nested untrusted payloads:** the sources do not say whether attrs can parse or validate nested dictionaries or JSON payloads directly. Its own materials describe a class-definition tool [S1][S3]. Any extra structuring library would have to be found in other sources.
- **Performance:** there are no benchmarks or performance comparisons in the fetched sources (gap statement) [S1][S2][S3].
- **Ecosystem:** no source compares framework integration or adoption for API payloads (gap statement) [S1][S2][S3].

## Sources

Fetched by AgentStation from approved domains. Hashes identify the exact text the agents read (stored in the station database).

- **S1**: [attrs on PyPI](https://pypi.org/project/attrs/). Retrieved 2026-10-09T22:09:05.350Z. SHA-256 of retrieved text: `bcf99b8c354a16fe…`
- **S2**: [pydantic/pydantic README.md (GitHub)](https://raw.githubusercontent.com/pydantic/pydantic/HEAD/README.md). Retrieved 2026-10-09T22:09:05.468Z. SHA-256 of retrieved text: `20f8172718f932a7…`
- **S3**: [python-attrs/attrs README.md (GitHub)](https://raw.githubusercontent.com/python-attrs/attrs/HEAD/README.md). Retrieved 2026-10-09T22:09:05.580Z. SHA-256 of retrieved text: `9b01f41e29935d0b…`
