# Review Summary: "Adaptive Thermal Regulation in Modular Reactor Cores" (Draft v3.2)

**Reviewer:** Dr. Elena Vasquez
**Date:** March 2024
**Document Author:** M. Tanaka, R. Okafor

## Overview

This review covers the internal technical report submitted by the Kestrel Systems engineering group regarding their proposed adaptive cooling architecture for modular reactor units (designated *MRU-7 series*). The document presents both simulation data and a theoretical framework for predicting thermal drift under variable load conditions.

## Key Findings

The core contribution of the paper is a *modified diffusion model* that accounts for non-uniform coolant flow. The authors claim their model reduces prediction error by roughly 18% compared to the baseline Kestrel-4 model. The central relaxation coefficient is defined as $\tau = \frac{\rho c_p L^2}{k}$, which governs the thermal response time of each core segment.

The report's headline result extends this into a full spatial-temporal formulation:

$$
\frac{\partial T(x,t)}{\partial t} = \alpha \nabla^2 T(x,t) - \beta \, v(x,t) \cdot \nabla T(x,t) + Q(x,t)
$$

This equation is reasonably well-justified in Section 4, though the derivation of $\beta$ (the convective coupling term) is only sketched informally.

> [!note]
> The simulation results in Appendix C use a **coarser mesh** (2.5 cm) than the production model (0.5 cm). This discrepancy should be explicitly flagged in the main text, not buried in a footnote.

> [!warning]
> Section 6.3 reports a *negative* effective heat capacity under one edge-case load profile. This is almost certainly a numerical artifact from the solver's adaptive timestep, but it is not addressed anywhere in the discussion.

## Questions for the Authors

1. How sensitive is the 18% error reduction to the choice of initial conditions in the calibration set?
2. Was the model validated against any ==out-of-distribution== load scenarios, or only interpolated cases?
3. The report mentions a "Phase-2 dataset" (Section 2.1) but this dataset is never described in the methods — where does it come from?
4. Is $\beta$ assumed constant across all core segments, or does it vary spatially?

## Recommended Changes

- [x] Clarify mesh resolution discrepancy between Appendix C and the production model
- [x] Add explicit error bars to all figures in Section 5
- [ ] Investigate and explain the negative heat capacity artifact in Section 6.3
- [ ] Provide full derivation of the convective coupling term $\beta$
- [ ] Include a sensitivity analysis for the calibration dataset
- [ ] Add a glossary defining domain-specific acronyms (MRU, TCL, HFR)

## Structural Notes

The document's organization could be improved. Currently:

- Section 3 (Methods)
    - 3.1 Data Collection
        - 3.1.1 Sensor Calibration
            - 3.1.1.a Thermal probes
            - 3.1.1.b Flow meters
    - 3.2 Model Architecture
    - 3.3 Validation Protocol

This nesting is fine structurally, but **3.1.1** duplicates content already present in Appendix B, and should either be trimmed or cross-referenced instead of repeated verbatim.

## Sample Data Snippet

For reproducibility, the authors should include representative config files. A minimal example is shown below:

```yaml
reactor_id: MRU-7c
mesh_resolution_cm: 0.5
coolant_flow_lps: 42.7
initial_temp_k: 583
solver: adaptive_rk45
tolerance: 1e-6
```

## Overall Assessment

This is a *solid* draft with genuinely useful modeling insight, but it requires **moderate revision** before it is ready for external circulation. The mathematical core is sound; the presentation and validation narrative need tightening.
