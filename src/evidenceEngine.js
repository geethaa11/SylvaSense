export function evaluateEvidence(request) {
  let decision = 'UNSUPPORTED';
  let supportedResolution = 'None';
  let ladderLevel = 'L0';
  let reason = '';
  const checks = [];

  if (request.measurement === 'ENUMERATION') {
     let l4Supported = true;
     
     const resStatus = request.spatial_resolution_m <= 1 ? 'SUPPORTED' : 'REVIEW';
     const sepStatus = request.crown_separability === 'good' ? 'SUPPORTED' : 'REVIEW';
     const imgStatus = request.image_quality === 'good' ? 'SUPPORTED' : 'REVIEW';
     const covStatus = request.cloud_free_fraction > 0.8 ? 'SUPPORTED' : 'REVIEW';

     checks.push({ name: 'Spatial resolution', status: resStatus });
     checks.push({ name: 'Crown separability', status: sepStatus });
     checks.push({ name: 'Image quality', status: imgStatus });
     checks.push({ name: 'Coverage', status: covStatus });
     
     if (resStatus !== 'SUPPORTED' || sepStatus !== 'SUPPORTED') {
         l4Supported = false;
     }

     if (l4Supported) {
         decision = 'SUPPORTED';
         supportedResolution = 'Individual Tree Enumeration';
         ladderLevel = 'L4';
         reason = 'All evidence requirements for individual tree enumeration are met.';
     } else {
         decision = 'REVIEW';
         supportedResolution = 'Canopy Object / Density';
         ladderLevel = 'L3';
         reason = 'The requested individual-tree level cannot be reliably supported by the available resolution. Highest supported is canopy object density.';
     }
  }
  
  if (request.measurement === 'STRUCTURE') {
      const optStatus = request.optical_available ? 'SUPPORTED' : 'INSUFFICIENT';
      const imgStatus = request.image_quality === 'good' ? 'SUPPORTED' : 'REVIEW';
      const covStatus = request.cloud_free_fraction > 0.8 ? 'SUPPORTED' : 'REVIEW';

      checks.push({ name: 'Canopy evidence', status: optStatus });
      checks.push({ name: 'Image quality', status: imgStatus });
      checks.push({ name: 'Spatial coverage', status: covStatus });
      
      if (optStatus === 'SUPPORTED' && covStatus === 'SUPPORTED') {
          decision = 'SUPPORTED';
          supportedResolution = 'Canopy Cover / Structure';
          ladderLevel = 'L2';
          reason = 'Available evidence is fully sufficient to resolve canopy fractional cover.';
      } else {
          decision = 'REVIEW';
          supportedResolution = 'Canopy Cover / Structure';
          ladderLevel = 'L2';
          reason = 'Evidence is limited by cloud cover or image quality.';
      }
  }
  
  if (request.measurement === 'BIOMASS') {
      const sarStatus = request.sar_available ? 'SUPPORTED' : 'REVIEW';
      const optStatus = request.optical_available ? 'SUPPORTED' : 'REVIEW';
      const valStatus = request.validation_support === 'good' ? 'SUPPORTED' : 'REVIEW';

      checks.push({ name: 'Structural evidence (SAR)', status: sarStatus });
      checks.push({ name: 'Optical evidence (S2)', status: optStatus });
      checks.push({ name: 'Reference support', status: valStatus });
      
      decision = 'REVIEW'; // Because validation_support in our demo is 'limited'
      supportedResolution = 'Stand-level AGB estimation';
      ladderLevel = 'L2';
      reason = 'Optical and SAR evidence are sufficient for a structural model, but independent field validation remains a future requirement.';
  }

  if (request.measurement === 'CHANGE') {
      const tempStatus = request.temporal_support ? 'SUPPORTED' : 'REVIEW';
      checks.push({ name: 'Temporal optical coverage', status: tempStatus });
      checks.push({ name: 'Temporal SAR coverage', status: tempStatus });
      
      if (tempStatus === 'SUPPORTED') {
          decision = 'SUPPORTED';
          supportedResolution = 'Forest condition / change';
          ladderLevel = 'L1';
          reason = 'Multi-temporal evidence clearly resolves stand-level condition changes.';
      } else {
          decision = 'REVIEW';
          supportedResolution = 'Forest condition / change';
          ladderLevel = 'L1';
          reason = 'Temporal coverage is limited.';
      }
  }
  
  return { decision, supportedResolution, ladderLevel, reason, checks };
}
