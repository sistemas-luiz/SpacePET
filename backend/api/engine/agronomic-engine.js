// ============================================================================
// BACKEND AGRONOMIC, BIOPHYSICAL & FINANCIAL ENGINE
// ============================================================================

function calculatePolygonAreaHa(latlngs) {
  if (!latlngs || latlngs.length < 3) return 50.0;
  const earthRadius = 6378137;
  let area = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const p1 = latlngs[i];
    const p2 = latlngs[(i + 1) % latlngs.length];
    const lat1 = p1[0] * Math.PI / 180;
    const lat2 = p2[0] * Math.PI / 180;
    const dLon = (p2[1] - p1[1]) * Math.PI / 180;
    area += dLon * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  area = Math.abs(area * earthRadius * earthRadius / 2.0);
  return Math.max(1.0, Math.min(25000, area / 10000.0));
}

function estimateClimateNdvi(rainMm, tempC) {
  if (tempC < 0) return 0.12;
  const aridity = rainMm / Math.max(150, (tempC + 10) * 45);
  return Number(Math.max(0.10, Math.min(0.82, 0.14 + aridity * 0.48)).toFixed(2));
}

function computeEt0HargreavesSamani(tempC, solarMjM2Day) {
  return Number(Math.max(1.0, 0.0135 * (tempC + 17.78) * (solarMjM2Day / 2.45)).toFixed(2));
}

function computeWaterBalance(rainMmYear, et0MmDay) {
  return Math.round(rainMmYear - (et0MmDay * 365.0));
}

function computeFao33YieldPreservation(ky, rainDeltaPct, tempDeltaC, baseTempC, solarMjM2Day, mulchEsReduction, irrigated, frostActive, frostTolerance) {
  let etaEtc;
  if (irrigated) {
    etaEtc = Math.max(0.75, Math.min(1.0, 0.98 - Math.max(0, tempDeltaC) * 0.015 + mulchEsReduction * 0.05));
  } else {
    const et0Base = computeEt0HargreavesSamani(baseTempC, solarMjM2Day);
    const et0Stressed = computeEt0HargreavesSamani(baseTempC + tempDeltaC, solarMjM2Day);
    const effectiveSupply = (1.0 + rainDeltaPct / 100.0) * (1.0 + mulchEsReduction * 0.38);
    etaEtc = Math.max(0.35, Math.min(1.0, effectiveSupply * (et0Base / et0Stressed)));
  }
  let preserved = (1.0 - ky * (1.0 - etaEtc)) * 100;
  if (frostActive) preserved -= (1 - frostTolerance) * 22;
  return Math.round(Math.max(22, Math.min(99, preserved)));
}

function computeUreaSavingsBrl(nFixedKgHa) {
  return Math.round(((nFixedKgHa * 0.50) / 0.45) * 3.20);
}

function computeAgroShieldDecision(p, eff, currentState, stressRainPct = 0, stressTempDelta = 0) {
  const zarc = classifySoilZarc(p.soil);
  const dap = Number(p.dap ?? 20);
  const baseEto = Math.max(1.8, 0.0135 * (currentState.nasaTemp + stressTempDelta + 17.78) * (currentState.nasaSolar / 2.45));
  const dailyRainAvg = Math.max(0.2, (currentState.nasaRain / 365) * (1 + stressRainPct / 100));

  const { kc: kc0, zCm: z0 } = obterParametrosCulturaAgroShield(p.crop, dap);
  const cad0 = zarc.ad * z0 * 10.0;
  const smapSatFraction = Math.max(0.18, Math.min(0.95, (eff.smapMoisture - 8) / 28));
  let arm = Math.max(0, Math.min(cad0, smapSatFraction * cad0));
  if (p.irrigation === 'irrigado') arm = Math.max(arm, 0.78 * cad0);

  const armAtual = arm, cadAtual = cad0;
  const statusAtual = armAtual <= 0.5 * cadAtual ? 'Seco' : 'Úmido';
  let alertaIrrigacao = false, diasAteSeca = 14;

  for (let d = 1; d <= 14; d++) {
    const { kc, zCm } = obterParametrosCulturaAgroShield(p.crop, dap + d);
    const cadDiaria = zarc.ad * zCm * 10.0;
    const etc = baseEto * kc;
    const chuvaDia = stressRainPct <= -15 ? dailyRainAvg * 0.35 : (d % 4 === 0 ? dailyRainAvg * 2.2 : dailyRainAvg * 0.45);
    let armCalc = Math.max(0, Math.min(cadDiaria, arm + chuvaDia - etc));
    const satArm = smapSatFraction * cadDiaria;
    if (Math.abs(armCalc - satArm) > 0.2 * cadDiaria) armCalc = armCalc * 0.7 + satArm * 0.3;
    arm = armCalc;
    if (!alertaIrrigacao && arm <= 0.5 * cadDiaria) { alertaIrrigacao = true; diasAteSeca = d; }
  }

  const pctCad = Math.round((armAtual / Math.max(1, cadAtual)) * 100);
  let mensagemStatus = 'Terra com boa umidade para os próximos 14 dias';
  if (statusAtual === 'Seco') {
    mensagemStatus = p.irrigation === 'irrigado'
      ? 'Terra seca: hora de ligar a irrigação para não perder produção'
      : 'Terra com pouca água: cubra o solo com palhada antes de plantar';
  } else if (alertaIrrigacao) {
    mensagemStatus = p.irrigation === 'irrigado'
      ? `Atenção: programar irrigação em até ${diasAteSeca} dias`
      : `Atenção: umidade segura por cerca de ${diasAteSeca} dias sem chuva`;
  }

  return {
    zarcCode: zarc.zarcCode, ad: zarc.ad, dap, kc: kc0, zCm: Math.round(z0),
    cadMm: Math.round(cadAtual * 10) / 10, armMm: Math.round(armAtual * 10) / 10,
    pctCad, status: statusAtual, alertaIrrigacao, diasAteSeca, mensagemStatus
  };
}

function bonusClassifySoil(clayPercent, sandPercent) {
  if (clayPercent >= 35.0) return 'Argiloso';
  if (clayPercent >= 15.0 && clayPercent < 35.0) return sandPercent < 85.0 ? 'Médio' : 'Arenoso';
  return 'Arenoso';
}

function bonusCalculateAD(vwc33, vwc1500, tipoSolo = 'Médio') {
  const ad = vwc33 - vwc1500;
  if (!(ad > 0)) {
    const fallbacks = { Argiloso: 0.15, 'Médio': 0.11, Arenoso: 0.07 };
    return fallbacks[tipoSolo] ?? 0.11;
  }
  return ad;
}

function bonusRunWaterBalanceSimulation(weatherRows, ad, plantingDate, vwc33, vwc1500, cultura) {
  const results = [];
  let armPrev = null;

  for (const row of weatherRows) {
    const dap = bonusDiffDays(bonusParseISODate(row.date), plantingDate);
    if (dap < 0) continue;

    const { kc, zCm } = obterParametrosCulturaAgroShield(cultura, dap);
    const cadDiaria = ad * zCm * 10.0;
    const satSm = row.satellite_soil_moisture;
    const adRef = vwc33 - vwc1500;

    if (armPrev === null) {
      if (satSm !== null && satSm !== undefined && !Number.isNaN(satSm) && adRef > 0) {
        const satFraction = (satSm - vwc1500) / adRef;
        armPrev = Math.max(0.0, Math.min(satFraction * cadDiaria, cadDiaria));
      } else {
        armPrev = cadDiaria;
      }
    }

    const eto = row.et0_fao_evapotranspiration || 0.0;
    const chuva = row.precipitation_sum || 0.0;
    let armCalc = Math.max(0.0, Math.min(armPrev + chuva - (eto * kc), cadDiaria));

    if (satSm !== null && satSm !== undefined && !Number.isNaN(satSm) && adRef > 0) {
      const satArm = Math.max(0.0, Math.min(((satSm - vwc1500) / adRef) * cadDiaria, cadDiaria));
      if (Math.abs(armCalc - satArm) > 0.2 * cadDiaria) {
        armCalc = armCalc * 0.7 + satArm * 0.3;
      }
    }

    results.push({
      date: row.date,
      arm_mm: Math.round(armCalc * 100) / 100,
      cad_diaria_mm: Math.round(cadDiaria * 100) / 100,
      chuva_mm: Math.round(chuva * 100) / 100,
      eto_mm: Math.round(eto * 100) / 100
    });
    armPrev = armCalc;
  }
  return results;
}
