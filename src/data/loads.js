/**
 * src/data/loads.js
 * -----------------
 * Mock seed data for the load marketplace and carrier trip history.
 *
 * ARCHITECTURE NOTE:
 *   This file is the "mock database". It holds raw arrays exactly as a real
 *   database would store them. Nothing is transformed or computed here.
 *
 *   In production, this file is deleted. loadService.js will call the API
 *   instead — but nothing outside loadService.js changes.
 *
 *   Import path from portals (root level): ./src/data/loads.js
 *   Import path from src/ files:           ./data/loads.js
 */

/**
 * Loads currently available on the marketplace for carriers to book.
 * Shape matches the Load model defined in src/models/load.js.
 */
export const MARKETPLACE_LOADS = [
  {
    id:"KE-2041", cargo:"Bagged Maize",   from:"Eldoret",      to:"Nairobi",
    dist:312, weight:"28T", truck:"33T Flatbed", pay:42000, rateKm:135,
    pickD:"May 23", pickT:"8:00 AM",  delD:"May 23", delT:"4:30 PM",
    shipper:"Unga Group Ltd",  rating:4.8, urgent:true,  facilRating:4.2,
  },
  {
    id:"KE-2042", cargo:"Steel Coils",    from:"Mombasa Port", to:"Nairobi ICD",
    dist:485, weight:"22T", truck:"Lowbed",      pay:68500, rateKm:141,
    pickD:"May 24", pickT:"6:00 AM",  delD:"May 24", delT:"8:00 PM",
    shipper:"Steel & Tube",    rating:4.9, urgent:false, facilRating:4.6,
  },
  {
    id:"KE-2043", cargo:"Fresh Flowers",  from:"Naivasha",     to:"JKIA Cargo",
    dist:94,  weight:"4T",  truck:"Reefer Van",  pay:18000, rateKm:191,
    pickD:"May 23", pickT:"11:00 PM", delD:"May 24", delT:"3:00 AM",
    shipper:"Oserian Farm",    rating:4.7, urgent:true,  facilRating:4.4,
  },
  {
    id:"KE-2044", cargo:"Building Mats",  from:"Athi River",   to:"Kisumu",
    dist:398, weight:"30T", truck:"Open Truck",  pay:55000, rateKm:138,
    pickD:"May 25", pickT:"7:00 AM",  delD:"May 25", delT:"5:00 PM",
    shipper:"Bamburi Cement",  rating:4.6, urgent:false, facilRating:3.9,
  },
  {
    id:"KE-2045", cargo:"FMCG Goods",     from:"Nairobi EPZ",  to:"Kampala, UG",
    dist:680, weight:"18T", truck:"Box Truck",   pay:95000, rateKm:140,
    pickD:"May 26", pickT:"5:00 AM",  delD:"May 27", delT:"2:00 PM",
    shipper:"Unilever Kenya",  rating:5.0, urgent:false, facilRating:4.8,
  },
  {
    id:"KE-2046", cargo:"Quarry Ballast", from:"Mlolongo",     to:"Thika Road Site",
    dist:48,  weight:"30T", truck:"Tipper",      pay:22000, rateKm:458,
    pickD:"May 23", pickT:"7:00 AM",  delD:"May 23", delT:"10:00 AM",
    shipper:"China Wu Yi",     rating:4.5, urgent:true,  facilRating:4.0,
  },
  {
    id:"KE-2047", cargo:"Red Murram",     from:"Athi River",   to:"Karen, Nairobi",
    dist:35,  weight:"28T", truck:"Tipper",      pay:18000, rateKm:514,
    pickD:"May 24", pickT:"6:00 AM",  delD:"May 24", delT:"8:30 AM",
    shipper:"Mombasa Cement",  rating:4.3, urgent:false, facilRating:3.8,
  },
  {
    id:"KE-2048", cargo:"Sand & Hardcore", from:"Machakos",    to:"Syokimau",
    dist:62,  weight:"25T", truck:"Tipper",      pay:25000, rateKm:403,
    pickD:"May 25", pickT:"5:30 AM",  delD:"May 25", delT:"9:00 AM",
    shipper:"KenGen Ltd",      rating:4.7, urgent:false, facilRating:4.1,
  },
];

/**
 * Filter chip options for the load marketplace.
 * Kept here (not in reference.js) because it filters marketplace loads
 * specifically, not a general lookup list.
 */
export const TRUCK_FILTERS = [
  "All", "Flatbed", "Reefer", "Lowbed", "Box Truck", "Open Truck", "Tipper",
];
