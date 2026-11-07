'use strict';

(function initTaintFactorRegistry(global) {
  const GENERATED_AT = '2026-06-10';
  const NEXT_REVIEW_DUE = '2026-12-31';
  const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);
  const SOURCE_TIER_BY_TYPE = {
    official_government: 1,
    international_standard: 1,
    accounting_standard: 1,
    international_methodology: 1,
    industry_methodology: 2,
    peer_reviewed_journal: 2,
    model_assumption: 3
  };
  const UNCERTAINTY_BY_CONFIDENCE = {
    high: 0.10,
    medium: 0.25,
    low: 0.50
  };
  const CLAIMS_BLOCKED_BOUNDARIES = new Set([
    'activity_distance_adjustment',
    'activity_multiplier',
    'qualitative_pollution_visual_proxy',
    'screening_estimate'
  ]);

  const SOURCES = {
    cea_grid: {
      source_url: 'https://cea.nic.in/cdm-co2-baseline-database/?lang=en',
      source_type: 'official_government'
    },
    ipcc_mobile: {
      source_url: 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol2.html',
      source_type: 'international_standard'
    },
    ghgp_scope2: {
      source_url: 'https://ghgprotocol.org/scope-2-guidance',
      source_type: 'accounting_standard'
    },
    ghgp_scope3: {
      source_url: 'https://ghgprotocol.org/corporate-value-chain-scope-3-standard',
      source_type: 'accounting_standard'
    },
    icao: {
      source_url: 'https://www.icao.int/environmental-protection/environmental-tools/icec',
      source_type: 'international_methodology'
    },
    bee: {
      source_url: 'https://www.beestarlabel.com/',
      source_type: 'official_government'
    },
    swd: {
      source_url: 'https://sustainablewebdesign.org/calculating-digital-emissions/',
      source_type: 'industry_methodology'
    },
    methodology: {
      source_url: 'https://github.com/sabarivasantkmech-blip/taint/blob/main/docs/factor-registry.md',
      source_type: 'model_assumption'
    }
  };

  const factors = [];

  function normalizeValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : value;
  }

  function uncertaintyFor(confidence, boundary) {
    const base = UNCERTAINTY_BY_CONFIDENCE[confidence] ?? 0.50;
    if (/proxy|heuristic|screening|qualitative/i.test(boundary || '')) return Math.max(base, 0.50);
    return base;
  }

  function scaleStatusFor(sourceType, confidence, boundary) {
    if (confidence === 'low' || sourceType === 'model_assumption' || /proxy|heuristic|qualitative/i.test(boundary || '')) {
      return 'screening_only';
    }
    if (confidence === 'medium') return 'india_screening_ready';
    return 'audit_candidate';
  }

  function claimsAllowed(sourceType, confidence, boundary) {
    return confidence !== 'low' && sourceType !== 'model_assumption' && !CLAIMS_BLOCKED_BOUNDARIES.has(boundary);
  }

  function add(entry) {
    if (!CONFIDENCE_VALUES.has(entry.confidence)) {
      throw new Error(`Unsupported factor confidence: ${entry.id}`);
    }
    const sourceTier = SOURCE_TIER_BY_TYPE[entry.source_type] || 3;
    const uncertainty = uncertaintyFor(entry.confidence, entry.boundary);
    factors.push({
      id: entry.id,
      domain: entry.domain,
      label: entry.label,
      value: normalizeValue(entry.value),
      unit: entry.unit,
      geography: entry.geography,
      year: entry.year,
      source_url: entry.source_url,
      source_type: entry.source_type,
      source_tier: sourceTier,
      boundary: entry.boundary,
      confidence: entry.confidence,
      uncertainty_pct: uncertainty,
      scale_status: scaleStatusFor(entry.source_type, entry.confidence, entry.boundary),
      claims_allowed: claimsAllowed(entry.source_type, entry.confidence, entry.boundary),
      review_status: entry.confidence === 'low' ? 'needs_local_validation' : 'source_linked',
      reviewed_at: GENERATED_AT,
      next_review_due: NEXT_REVIEW_DUE,
      calculation_role: entry.calculation_role || 'emission_factor',
      notes: entry.notes || ''
    });
  }

  function factor(id, domain, label, value, unit, geography, year, source, boundary, confidence, notes) {
    add({
      id,
      domain,
      label,
      value,
      unit,
      geography,
      year,
      source_url: source.source_url,
      source_type: source.source_type,
      boundary,
      confidence,
      notes
    });
  }

  [
    ['grid.chennai', 'Chennai / Tamil Nadu', 0.716],
    ['grid.mumbai', 'Mumbai / Maharashtra', 0.820],
    ['grid.delhi', 'Delhi / NCR', 0.820],
    ['grid.bengaluru', 'Bengaluru / Karnataka', 0.550],
    ['grid.hyderabad', 'Hyderabad / Telangana', 0.760],
    ['grid.kolkata', 'Kolkata / West Bengal', 0.870],
    ['grid.pune', 'Pune / Maharashtra', 0.820],
    ['grid.ahmedabad', 'Ahmedabad / Gujarat', 0.680],
    ['grid.kochi', 'Kochi / Kerala', 0.430],
    ['grid.jaipur', 'Jaipur / Rajasthan', 0.780],
    ['grid.india_swd', 'India', 0.716]
  ].forEach(([id, geography, value]) => {
    factor(id, 'electricity', `${geography} grid intensity`, value, 'kgCO2e/kWh', geography, 2023, SOURCES.cea_grid, 'location_based_scope2', 'medium', 'State/city grid intensity used by current app calculations.');
  });

  [
    ['commute.two.petrol.scooter', 'Petrol Scooter / Moped BS6', 47, 'India urban', 'tailpipe_operational'],
    ['commute.two.petrol.bike_100', 'Petrol Motorbike 100-150cc BS6', 57, 'India urban', 'tailpipe_operational'],
    ['commute.two.petrol.bike_150', 'Petrol Bike 150cc+ BS6', 78, 'India urban', 'tailpipe_operational'],
    ['commute.two.cng.cng_bike', 'CNG Motorbike', 35, 'India urban', 'tailpipe_operational'],
    ['commute.two.hybrid.mhev_scoot', 'Mild Hybrid Scooter', 34, 'India urban', 'tailpipe_operational'],
    ['commute.two.hybrid.hev_scoot', 'Strong Hybrid Scooter', 26, 'India urban', 'tailpipe_operational'],
    ['commute.four.petrol.pet_htch', 'Petrol Hatchback', 104, 'India urban', 'tailpipe_operational'],
    ['commute.four.petrol.pet_sed', 'Petrol Sedan', 121, 'India urban', 'tailpipe_operational'],
    ['commute.four.petrol.pet_suv', 'Petrol SUV / MUV', 155, 'India urban', 'tailpipe_operational'],
    ['commute.four.diesel.die_sed', 'Diesel Sedan', 98, 'India urban', 'tailpipe_operational'],
    ['commute.four.diesel.die_suv', 'Diesel SUV / MUV', 138, 'India urban', 'tailpipe_operational'],
    ['commute.four.cng.cng_htch', 'CNG Hatchback', 90, 'India urban', 'tailpipe_operational'],
    ['commute.four.cng.cng_sed', 'CNG Sedan', 110, 'India urban', 'tailpipe_operational'],
    ['commute.four.cng.cng_suv', 'CNG SUV / MPV', 128, 'India urban', 'tailpipe_operational'],
    ['commute.four.hybrid.mhev_sed', 'Mild Hybrid Sedan', 88, 'India urban', 'tailpipe_operational'],
    ['commute.four.hybrid.hev_sed', 'Strong Hybrid Sedan', 70, 'India urban', 'tailpipe_operational'],
    ['commute.four.hybrid.hev_suv', 'Strong Hybrid SUV', 90, 'India urban', 'tailpipe_operational'],
    ['commute.four.hybrid.phev_sed', 'Plug-in Hybrid Sedan', 55, 'India urban', 'tailpipe_operational'],
    ['commute.four.hybrid.phev_suv', 'Plug-in Hybrid SUV', 73, 'India urban', 'tailpipe_operational'],
    ['commute.shared.petrol.taxi_htch', 'Petrol Taxi Hatchback', 130, 'India urban', 'tailpipe_operational'],
    ['commute.shared.petrol.taxi_sed', 'Petrol Taxi Sedan', 148, 'India urban', 'tailpipe_operational'],
    ['commute.shared.petrol.taxi_suv', 'Petrol Taxi SUV', 168, 'India urban', 'tailpipe_operational'],
    ['commute.shared.petrol.maxicab', 'Petrol Maxi-cab / Shared taxi', 175, 'India urban', 'tailpipe_operational'],
    ['commute.shared.petrol.minibus', 'Petrol Mini-bus', 280, 'India urban', 'tailpipe_operational'],
    ['commute.shared.cng.auto', 'Auto-rickshaw CNG', 55, 'India urban', 'tailpipe_operational'],
    ['commute.shared.cng.share_auto', 'Share Auto CNG', 55, 'India urban', 'tailpipe_operational'],
    ['commute.shared.cng.cng_bus', 'CNG City Bus', 520, 'India urban', 'tailpipe_operational'],
    ['commute.shared.diesel.bus', 'Diesel City Bus', 640, 'Chennai / India urban', 'tailpipe_operational']
  ].forEach(([id, label, value, geography, boundary]) => {
    factor(id, 'commute_vehicle', label, value, 'gCO2e/km_vehicle', geography, 2025, SOURCES.ipcc_mobile, boundary, 'medium', 'Operational road vehicle factor currently used by the commute calculator.');
  });

  [
    ['commute.two.electric.ev_cycle', 'E-bicycle / EV Cycle', 0.015],
    ['commute.two.electric.ev_scoot', 'EV Scooter', 0.033],
    ['commute.two.electric.ev_moto', 'EV Motorbike', 0.038],
    ['commute.four.electric.ev_htch', 'EV Hatchback', 0.140],
    ['commute.four.electric.ev_suv', 'EV Sedan / SUV', 0.165],
    ['commute.shared.electric.e_auto', 'Electric Auto / E-rickshaw', 0.020],
    ['commute.shared.electric.e_bus', 'Electric Bus', 0.300],
    ['transit.metro', 'Metro rail', 0.060],
    ['transit.suburban.default', 'Suburban rail default', 0.025],
    ['transit.monorail', 'Monorail', 0.055],
    ['transit.express', 'Indian Railways Express / Mail', 0.014],
    ['transit.premium', 'Vande Bharat / Rajdhani / Shatabdi', 0.008]
  ].forEach(([id, label, value]) => {
    factor(id, 'electric_mobility', label, value, 'kWh/km_vehicle', 'India urban', 2025, SOURCES.ghgp_scope2, 'use_phase_electricity', 'medium', 'Converted to gCO2e/km at runtime with selected city grid intensity.');
  });

  [
    ['transit.suburban.mumbai', 'Mumbai suburban rail', 0.013, 'Mumbai / Maharashtra'],
    ['transit.suburban.bengaluru', 'Bengaluru suburban rail', 0.028, 'Bengaluru / Karnataka'],
    ['transit.suburban.hyderabad', 'Hyderabad MMTS', 0.030, 'Hyderabad / Telangana'],
    ['transit.suburban.kolkata', 'Kolkata suburban rail', 0.022, 'Kolkata / West Bengal']
  ].forEach(([id, label, value, geography]) => {
    factor(id, 'electric_mobility', label, value, 'kWh/km_vehicle', geography, 2025, SOURCES.methodology, 'use_phase_electricity', 'low', 'City-specific rail energy proxy used by current app configuration.');
  });

  [
    ['puc.valid_clean', 'Valid clean PUC', 0.98],
    ['puc.valid_average', 'Valid average PUC', 1.00],
    ['puc.near_limit', 'Valid PUC near limit', 1.08],
    ['puc.expired', 'Expired or unavailable PUC', 1.15],
    ['puc.failed', 'Failed PUC', 1.25],
    ['puc.unknown', 'PUC unknown', 1.00],
    ['puc.co_gt_0_5', 'CO over 0.5 percent', 1.06],
    ['puc.co_gt_1', 'CO over 1 percent', 1.12],
    ['puc.co_gt_3', 'CO over 3 percent', 1.25],
    ['puc.smoke_gt_45', 'Diesel smoke opacity over 45 percent', 1.10],
    ['puc.smoke_gt_65', 'Diesel smoke opacity over 65 percent', 1.22]
  ].forEach(([id, label, value]) => {
    factor(id, 'adjustment', label, value, 'multiplier', 'India', 2025, SOURCES.methodology, 'tailpipe_condition_adjustment', 'low', 'Heuristic correction, not a certified emissions test conversion.');
  });

  [
    ['route.drive', 'Direct road route', 1.00],
    ['route.two', 'Two-wheeler road route', 1.00],
    ['route.bus', 'Indirect bus route', 1.15],
    ['route.shared', 'Shared/auto route variance', 1.10],
    ['route.cycle', 'Cycling route', 1.00],
    ['route.walk', 'Walking route', 1.00],
    ['route.transit', 'Rail direct alignment', 0.95],
    ['congestion.peak', 'Peak hour congestion', 1.35],
    ['congestion.off_peak', 'Off-peak congestion', 1.12],
    ['congestion.shoulder', 'Shoulder congestion', 1.08],
    ['congestion.night', 'Night / low congestion', 1.03]
  ].forEach(([id, label, value]) => {
    factor(id, 'routing_adjustment', label, value, 'multiplier', 'Chennai calibrated / India urban proxy', 2025, SOURCES.methodology, 'activity_distance_adjustment', 'low', 'Distance/activity proxy used to adjust routed distance, not an emissions factor by itself.');
  });

  [
    ['impact_proxy.diesel', 'Diesel relative local impact proxy', 1.45],
    ['impact_proxy.petrol', 'Petrol relative local impact proxy', 1.00],
    ['impact_proxy.cng', 'CNG relative local impact proxy', 0.72],
    ['impact_proxy.hybrid', 'Hybrid relative local impact proxy', 0.75],
    ['impact_proxy.electric', 'Electric relative local impact proxy', 0.18],
    ['impact_proxy.rail', 'Rail relative local impact proxy', 0.12],
    ['impact_proxy.local_tailpipe_low', 'Low local tailpipe proxy for electric/rail/transit', 0.18]
  ].forEach(([id, label, value]) => {
    factor(id, 'impact_proxy', label, value, 'multiplier', 'Chennai visual model / India urban proxy', 2025, SOURCES.methodology, 'qualitative_pollution_visual_proxy', 'low', 'Used for City Vision visual haze only; not measured AQI, PM2.5, NOx, or carbon accounting.');
  });

  [
    ['digital.grid_india', 'India grid for digital carbon', 716, 'gCO2e/kWh', 'India', SOURCES.cea_grid, 'location_based_scope2', 'medium'],
    ['digital.energy_per_gb', 'Sustainable Web Design data energy', 0.300, 'kWh/GB', 'Global', SOURCES.swd, 'digital_transfer_lifecycle_proxy', 'medium']
  ].forEach(([id, label, value, unit, geography, source, boundary, confidence]) => {
    factor(id, 'digital', label, value, unit, geography, 2023, source, boundary, confidence, 'Used by the site carbon tracker.');
  });

  [
    ['workplace.grid_default', 'Workplace default grid intensity', 0.716, 'kgCO2e/kWh', 'India / Tamil Nadu default', SOURCES.cea_grid, 'location_based_scope2', 'medium'],
    ['workplace.diesel_generator', 'Diesel generator combustion', 2.68, 'kgCO2e/litre', 'India', SOURCES.ipcc_mobile, 'scope1_combustion', 'medium'],
    ['workplace.lpg', 'LPG combustion', 2.983, 'kgCO2e/kg_fuel', 'India', SOURCES.ipcc_mobile, 'scope1_combustion', 'medium'],
    ['workplace.ac_kw_per_ton', 'Office AC runtime power', 1.17, 'kW/ton_cooling', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['workplace.laptop_power', 'Laptop active power', 50, 'W/device', 'Global office proxy', SOURCES.methodology, 'energy_model', 'medium'],
    ['workplace.desktop_power', 'Desktop active power', 200, 'W/device', 'Global office proxy', SOURCES.methodology, 'energy_model', 'medium'],
    ['workplace.monitor_power', 'Monitor active power', 30, 'W/device', 'Global office proxy', SOURCES.methodology, 'energy_model', 'medium'],
    ['workplace.printer_page', 'Printed page lifecycle and toner', 0.000018, 'tCO2e/page', 'Global proxy', SOURCES.swd, 'lifecycle_proxy', 'low'],
    ['workplace.flight_domestic', 'Domestic flight passenger-km', 0.255, 'kgCO2e/passenger_km', 'India / global aviation', SOURCES.icao, 'scope3_business_travel', 'medium'],
    ['workplace.flight_international', 'International flight passenger-km', 0.195, 'kgCO2e/passenger_km', 'Global aviation', SOURCES.icao, 'scope3_business_travel', 'medium'],
    ['workplace.train', 'Rail passenger-km', 0.047, 'kgCO2e/passenger_km', 'India', SOURCES.methodology, 'scope3_business_travel', 'low'],
    ['workplace.road_car', 'Intercity road car', 0.140, 'kgCO2e/km', 'India', SOURCES.ipcc_mobile, 'scope3_business_travel', 'medium'],
    ['workplace.commute_car', 'Employee commute car share', 0.063, 'kgCO2e/km_person', 'Chennai / India urban', SOURCES.methodology, 'scope3_employee_commuting', 'low'],
    ['workplace.commute_bus', 'Employee commute bus share', 0.028, 'kgCO2e/km_person', 'Chennai / India urban', SOURCES.methodology, 'scope3_employee_commuting', 'low'],
    ['workplace.commute_metro', 'Employee commute metro share', 0.035, 'kgCO2e/km_person', 'Chennai / India urban', SOURCES.methodology, 'scope3_employee_commuting', 'low'],
    ['workplace.commute_auto', 'Employee commute auto share', 0.082, 'kgCO2e/km_person', 'Chennai / India urban', SOURCES.methodology, 'scope3_employee_commuting', 'low'],
    ['workplace.paper_ream', 'Office paper ream lifecycle', 4.4, 'kgCO2e/500_sheets', 'India / global proxy', SOURCES.ghgp_scope3, 'scope3_purchased_goods', 'low'],
    ['workplace.water_treatment', 'Water treatment', 0.344, 'kgCO2e/m3', 'India urban proxy', SOURCES.methodology, 'scope3_resources', 'low'],
    ['workplace.waste_landfill', 'Landfill waste', 0.5, 'kgCO2e/kg_waste', 'India urban proxy', SOURCES.methodology, 'scope3_waste', 'low'],
    ['workplace.office_meal', 'Average Indian office meal', 0.8, 'kgCO2e/meal', 'India', SOURCES.ghgp_scope3, 'scope3_food_proxy', 'low'],
    ['workplace.wfh_laptop', 'WFH laptop', 50, 'W/device', 'Global office proxy', SOURCES.methodology, 'energy_model', 'medium'],
    ['workplace.wfh_laptop_monitor', 'WFH laptop plus monitor', 80, 'W/setup', 'Global office proxy', SOURCES.methodology, 'energy_model', 'medium'],
    ['workplace.wfh_desktop', 'WFH desktop', 200, 'W/setup', 'Global office proxy', SOURCES.methodology, 'energy_model', 'medium'],
    ['workplace.wfh_ac', 'WFH AC', 1200, 'W/unit', 'India urban', SOURCES.bee, 'energy_model', 'medium']
  ].forEach(([id, label, value, unit, geography, source, boundary, confidence]) => {
    factor(id, 'workplace', label, value, unit, geography, 2025, source, boundary, confidence, 'Current workplace calculator factor.');
  });

  [
    ['home.lpg_cylinder_mass', 'Domestic LPG cylinder mass', 14.2, 'kg/cylinder', 'India', SOURCES.methodology, 'activity_data', 'high'],
    ['home.lpg_combustion', 'LPG combustion', 2.983, 'kgCO2e/kg_fuel', 'India', SOURCES.ipcc_mobile, 'scope1_combustion', 'medium'],
    ['home.png_combustion', 'Piped natural gas combustion', 2.220, 'kgCO2e/SCM', 'India', SOURCES.ipcc_mobile, 'scope1_combustion', 'medium'],
    ['home.induction_power', 'Induction cooktop', 1.5, 'kW/device', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.microwave_power', 'Microwave oven', 0.9, 'kW/device', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.ac_kw_per_ton', 'Home AC runtime power', 1.17, 'kW/ton_cooling', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.fan_power', 'Ceiling fan', 0.075, 'kW/device', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.geyser_kwh_per_litre', 'Geyser water heating', 0.039, 'kWh/litre', 'India urban', SOURCES.methodology, 'energy_model', 'medium'],
    ['home.fridge_small', 'Small refrigerator', 0.5, 'kWh/day', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.fridge_medium', 'Medium refrigerator', 1.0, 'kWh/day', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.fridge_large', 'Large refrigerator', 1.5, 'kWh/day', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.fridge_double', 'Double-door refrigerator', 2.0, 'kWh/day', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.washing_machine', 'Washing machine load', 0.5, 'kWh/load', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.tv_power', 'Television', 0.10, 'kW/device', 'India urban', SOURCES.bee, 'energy_model', 'medium'],
    ['home.laptop_power', 'Laptop', 0.05, 'kW/device', 'Global proxy', SOURCES.methodology, 'energy_model', 'medium'],
    ['home.water_treatment', 'Water treatment', 0.344, 'kgCO2e/m3', 'India urban proxy', SOURCES.methodology, 'scope3_resources', 'low'],
    ['home.ro_waste_factor', 'RO water reject factor', 4, 'multiplier', 'India urban proxy', SOURCES.methodology, 'activity_multiplier', 'low'],
    ['home.car_petrol', 'Household petrol car', 0.170, 'kgCO2e/km', 'India urban', SOURCES.ipcc_mobile, 'tailpipe_operational', 'medium'],
    ['home.car_diesel', 'Household diesel car', 0.155, 'kgCO2e/km', 'India urban', SOURCES.ipcc_mobile, 'tailpipe_operational', 'medium'],
    ['home.car_cng', 'Household CNG car', 0.105, 'kgCO2e/km', 'India urban', SOURCES.ipcc_mobile, 'tailpipe_operational', 'medium'],
    ['home.car_ev_energy', 'Household EV car energy', 0.2, 'kWh/km', 'India urban', SOURCES.ghgp_scope2, 'use_phase_electricity', 'medium'],
    ['home.bike_petrol', 'Household petrol bike', 0.060, 'kgCO2e/km', 'India urban', SOURCES.ipcc_mobile, 'tailpipe_operational', 'medium'],
    ['home.bike_ev_energy', 'Household electric bike energy', 0.04, 'kWh/km', 'India urban', SOURCES.ghgp_scope2, 'use_phase_electricity', 'medium'],
    ['home.cab', 'Household cab / pooled ride', 0.100, 'kgCO2e/km', 'India urban', SOURCES.ipcc_mobile, 'tailpipe_operational', 'medium'],
    ['home.flight_domestic', 'Domestic flight passenger-km', 0.255, 'kgCO2e/passenger_km', 'India / global aviation', SOURCES.icao, 'scope3_travel', 'medium'],
    ['home.flight_international', 'International flight passenger-km', 0.195, 'kgCO2e/passenger_km', 'Global aviation', SOURCES.icao, 'scope3_travel', 'medium'],
    ['home.domestic_flight_avg', 'Typical domestic round trip leg proxy', 900, 'km/one_way_trip', 'India', SOURCES.methodology, 'activity_data', 'low'],
    ['home.international_flight_avg', 'Typical international round trip leg proxy', 5000, 'km/one_way_trip', 'India outbound proxy', SOURCES.methodology, 'activity_data', 'low'],
    ['home.diet_vegan', 'Vegan diet', 2.50, 'kgCO2e/person_day', 'India proxy', SOURCES.ghgp_scope3, 'food_lifecycle_proxy', 'low'],
    ['home.diet_vegetarian', 'Vegetarian diet', 2.80, 'kgCO2e/person_day', 'India proxy', SOURCES.ghgp_scope3, 'food_lifecycle_proxy', 'low'],
    ['home.diet_eggetarian', 'Eggetarian diet', 3.20, 'kgCO2e/person_day', 'India proxy', SOURCES.ghgp_scope3, 'food_lifecycle_proxy', 'low'],
    ['home.diet_nonveg_occ', 'Occasional non-vegetarian diet', 3.80, 'kgCO2e/person_day', 'India proxy', SOURCES.ghgp_scope3, 'food_lifecycle_proxy', 'low'],
    ['home.diet_nonveg_reg', 'Regular non-vegetarian diet', 5.00, 'kgCO2e/person_day', 'India proxy', SOURCES.ghgp_scope3, 'food_lifecycle_proxy', 'low'],
    ['home.eat_out_extra', 'Eating out meal extra', 0.8, 'kgCO2e/meal', 'India urban proxy', SOURCES.methodology, 'food_lifecycle_proxy', 'low'],
    ['home.clothing_item', 'Average garment lifecycle', 15, 'kgCO2e/item', 'India / global proxy', SOURCES.ghgp_scope3, 'purchased_goods_lifecycle', 'low'],
    ['home.electronics_item', 'Average smartphone/gadget lifecycle', 80, 'kgCO2e/item', 'India / global proxy', SOURCES.ghgp_scope3, 'purchased_goods_lifecycle', 'low'],
    ['home.appliance_item', 'Large appliance lifecycle', 400, 'kgCO2e/item', 'India / global proxy', SOURCES.ghgp_scope3, 'purchased_goods_lifecycle', 'low'],
    ['home.delivery', 'Online delivery', 0.50, 'kgCO2e/delivery', 'India urban proxy', SOURCES.ghgp_scope3, 'distribution_proxy', 'low'],
    ['home.furniture_low', 'Small furniture purchase', 25, 'kgCO2e/item', 'India / global proxy', SOURCES.ghgp_scope3, 'purchased_goods_lifecycle', 'low'],
    ['home.furniture_medium', 'Medium furniture purchase', 120, 'kgCO2e/item', 'India / global proxy', SOURCES.ghgp_scope3, 'purchased_goods_lifecycle', 'low'],
    ['home.furniture_high', 'Large furniture purchase', 350, 'kgCO2e/item', 'India / global proxy', SOURCES.ghgp_scope3, 'purchased_goods_lifecycle', 'low'],
    ['home.plastic_high', 'High plastic use', 2.0, 'kg/month', 'India urban proxy', SOURCES.methodology, 'activity_data', 'low'],
    ['home.plastic_medium', 'Medium plastic use', 1.0, 'kg/month', 'India urban proxy', SOURCES.methodology, 'activity_data', 'low'],
    ['home.plastic_low', 'Low plastic use', 0.3, 'kg/month', 'India urban proxy', SOURCES.methodology, 'activity_data', 'low'],
    ['home.plastic_none', 'Minimal plastic use', 0.05, 'kg/month', 'India urban proxy', SOURCES.methodology, 'activity_data', 'low'],
    ['home.plastic_lifecycle', 'Plastic production and disposal', 3.0, 'kgCO2e/kg_plastic', 'India / global proxy', SOURCES.ghgp_scope3, 'waste_lifecycle_proxy', 'low']
  ].forEach(([id, label, value, unit, geography, source, boundary, confidence]) => {
    factor(id, 'home', label, value, unit, geography, 2025, source, boundary, confidence, 'Current home calculator factor.');
  });

  [
    ['mytaint.walk', 'My Taint walk commute', 0],
    ['mytaint.cycle', 'My Taint cycle commute', 5],
    ['mytaint.two_petrol', 'My Taint petrol two-wheeler', 63],
    ['mytaint.car_petrol', 'My Taint petrol car', 140],
    ['mytaint.car_cng', 'My Taint CNG car', 105],
    ['mytaint.auto', 'My Taint auto', 55],
    ['mytaint.bus', 'My Taint bus', 28],
    ['mytaint.cab', 'My Taint cab', 100]
  ].forEach(([id, label, value]) => {
    factor(id, 'my_taint', label, value, 'gCO2e/km_person', 'India urban', 2025, SOURCES.methodology, 'screening_estimate', 'low', 'Simplified personal profile factor.');
  });
  factor('mytaint.two_ev_energy', 'my_taint', 'My Taint EV two-wheeler energy', 0.038, 'kWh/km', 'India urban', 2025, SOURCES.ghgp_scope2, 'use_phase_electricity', 'medium', 'Converted with selected city grid.');
  factor('mytaint.car_ev_energy', 'my_taint', 'My Taint EV car energy', 0.150, 'kWh/km', 'India urban', 2025, SOURCES.ghgp_scope2, 'use_phase_electricity', 'medium', 'Converted with selected city grid.');
  factor('mytaint.metro_energy', 'my_taint', 'My Taint metro energy', 0.060, 'kWh/km', 'India urban', 2025, SOURCES.ghgp_scope2, 'use_phase_electricity', 'medium', 'Converted with selected city grid.');

  const registry = {
    schema_version: '1.0.0',
    generated_for: 'TAINT carbon calculator',
    generated_at: GENERATED_AT,
    required_fields: ['id', 'domain', 'label', 'value', 'unit', 'geography', 'year', 'source_url', 'source_type', 'source_tier', 'boundary', 'confidence', 'uncertainty_pct', 'scale_status', 'claims_allowed', 'review_status', 'reviewed_at', 'next_review_due', 'calculation_role'],
    confidence_scale: {
      high: 'Official or directly measured factor with narrow interpretation.',
      medium: 'Recognized source or well-bounded model estimate.',
      low: 'Screening estimate, proxy, or local heuristic that needs validation before audited claims.'
    },
    source_tiers: {
      1: 'Official government, international standard, or accounting standard.',
      2: 'Peer-reviewed, industry methodology, or well-documented domain model.',
      3: 'Transparent app assumption that must remain labelled as screening-only.'
    },
    scale_statuses: {
      audit_candidate: 'Source-linked and bounded enough for future audited methodology review.',
      india_screening_ready: 'Adequate for India-wide public estimates with uncertainty disclosure.',
      screening_only: 'Usable in the app only as a transparent estimate, proxy, or local heuristic.'
    },
    scale_readiness: {
      chennai_commute: 'adequate_for_public_estimates',
      india_commute: 'adequate_for_screening_estimates',
      india_home: 'screening_only_until_india_lca_sources_are_added',
      india_workplace: 'screening_only_until_sector_benchmarks_are_replaced',
      india_taint_buy: 'screening_only_until_product_lca_sources_are_added',
      city_vision_impact_proxy: 'visual_proxy_only_not_aqi_or_health_claim'
    },
    sources: SOURCES,
    factors,
    byId(id) {
      return factors.find(item => item.id === id) || null;
    },
    byDomain(domain) {
      return factors.filter(item => item.domain === domain);
    }
  };

  global.TAINT_FACTOR_REGISTRY = Object.freeze(registry);
})(window);
